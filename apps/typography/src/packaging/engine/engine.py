"""Font construction engine.

Runs fontTools inside Pyodide, in a browser worker or in Node. The host writes
the source font to a file, calls one of the entry points with a JSON request,
and reads the result file. Entry points: build, build_variable, blank_font,
describe_layout, validate.
"""

import io
import json
import time
import unicodedata
from datetime import datetime, timezone

import fontTools.merge  # noqa: F401  registers mapLookups and mapFeatures on layout tables
from fontTools import subset, varLib
from fontTools.cu2qu import curves_to_quadratic
from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, InstanceDescriptor, SourceDescriptor
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.otlLib.builder import buildStatTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.varLib.featureVars import sortFeatureList
from fontTools.varLib.instancer import instantiateVariableFont

MAX_CURVE_ERROR = 1.0
SUBSTITUTION_LIMIT = 400
REQUIRED_TABLES = ("cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post")
BASE_GLYPH, MARK_GLYPH = 1, 3
SEGMENT_NAMES = {"line": "a line", "quadratic": "a quadratic curve", "cubic": "a cubic curve"}
FOUR_STYLES = ("Regular", "Italic", "Bold", "Bold Italic")
ELIDABLE_AXIS_VALUE = 0x2
WEIGHT_CLASSES = {"Thin": 100, "ExtraLight": 200, "Light": 300, "Regular": 400, "Medium": 500,
                  "SemiBold": 600, "Bold": 700, "ExtraBold": 800, "Black": 900}
# 1 January 2026 in seconds since 1904. A blank font carries no clock time, so
# the same request always gives the same bytes and the same source font digest.
BLANK_FONT_TIMESTAMP = 3_850_070_400
# A font counts its times in seconds from 1 January 1904, and a clock from 1 January 1970.
SECONDS_FROM_1904_TO_1970 = 2_082_844_800


def _reload(font):
    """Round-trips a font through bytes. Instanced fonts need this before subsetting."""
    buffer = io.BytesIO()
    font.save(buffer)
    buffer.seek(0)
    return TTFont(buffer)


def _point(value):
    return (round(value["x"]), round(value["y"]))


def _draw(outline, pen):
    for contour in outline["contours"]:
        pen.moveTo(_point(contour["start"]))
        for segment in contour["segments"]:
            kind = segment["kind"]
            if kind == "line":
                pen.lineTo(_point(segment["to"]))
            elif kind == "quadratic":
                pen.qCurveTo(_point(segment["control"]), _point(segment["to"]))
            elif kind == "spline":
                pen.qCurveTo(*segment["points"])
            else:
                pen.curveTo(_point(segment["control1"]), _point(segment["control2"]), _point(segment["to"]))
        pen.closePath()


def _signed_area(outline):
    """Shoelace area over every defining point. Positive means counter-clockwise."""
    total = 0.0
    for contour in outline["contours"]:
        points = [_point(contour["start"])]
        for segment in contour["segments"]:
            for key in ("control", "control1", "control2", "to"):
                if key in segment:
                    points.append(_point(segment[key]))
        for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1], strict=True):
            total += x1 * y2 - x2 * y1
    return total / 2


def _truetype_glyph(outline):
    """Draws an outline as a TrueType glyph: quadratic curves, clockwise outside.

    Masters of one variable font arrive with the direction already decided, so
    that every master turns the same way.
    """
    pen = TTGlyphPen(None)
    target = Cu2QuPen(pen, MAX_CURVE_ERROR)
    reverse = outline["reverse"] if "reverse" in outline else _signed_area(outline) > 0
    if reverse:
        target = ReverseContourPen(target)
    _draw(outline, target)
    return pen.glyph()


def _convert_to_truetype(font, notes):
    """Replaces CFF outlines with TrueType outlines so glyphs can be edited one way."""
    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(ReverseContourPen(Cu2QuPen(pen, MAX_CURVE_ERROR)))
        glyphs[name] = pen.glyph()
    advances = {name: font["hmtx"][name][0] for name in glyph_order}
    font["loca"] = newTable("loca")
    font["glyf"] = glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = glyphs
    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in font:
            del font[tag]
    for name in glyph_order:
        glyph = glyphs[name]
        glyph.recalcBounds(glyf)
        font["hmtx"][name] = (advances[name], getattr(glyph, "xMin", 0) if glyph.numberOfContours else 0)
    font["maxp"] = maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    for field in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
                  "maxStackElements", "maxSizeOfInstructions", "maxComponentElements"):
        setattr(maxp, field, 0)
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = glyph_order
    font.sfntVersion = "\x00\x01\x00\x00"
    notes.append("Converted PostScript outlines to TrueType outlines.")


def _set_glyph(font, name, outline, advance):
    glyf = font["glyf"]
    current_advance = font["hmtx"].metrics.get(name, (0, 0))[0]
    if outline is not None:
        glyf[name] = _truetype_glyph(outline)
    glyph = glyf[name]
    glyph.recalcBounds(glyf)
    left = getattr(glyph, "xMin", 0) if glyph.numberOfContours else 0
    font["hmtx"][name] = (round(current_advance if advance is None else advance), left)


def _map_characters(font, name, characters):
    cmap = font["cmap"]
    if any(code > 0xFFFF for code in characters) and not any(t.format == 12 for t in cmap.tables):
        full = CmapSubtable.newSubtable(12)
        full.platformID, full.platEncID, full.language = 3, 10, 0
        full.cmap = dict(font.getBestCmap() or {})
        cmap.tables.append(full)
    for table in cmap.tables:
        if not table.isUnicode() or table.format not in (4, 6, 10, 12):
            continue
        for code in characters:
            if code <= 0xFFFF or table.format in (10, 12):
                table.cmap[code] = name


def _classify(font, name, characters):
    if "GDEF" not in font or font["GDEF"].table.GlyphClassDef is None:
        return
    is_mark = any(unicodedata.category(chr(code)) in ("Mn", "Me") for code in characters)
    font["GDEF"].table.GlyphClassDef.classDefs[name] = MARK_GLYPH if is_mark else BASE_GLYPH


def _add_glyph(font, glyph):
    order = font.getGlyphOrder()
    name = glyph["name"]
    if name in order:
        raise ValueError(f"The font already has a glyph named {name}.")
    font["glyf"][name] = _truetype_glyph(glyph["outline"])
    if name not in font.getGlyphOrder():
        font.setGlyphOrder(order + [name])
    font["hmtx"][name] = (0, 0)
    _set_glyph(font, name, None, glyph["advance"])
    _map_characters(font, name, glyph["characters"])
    _classify(font, name, glyph["characters"])


def _extend_feature(existing, record):
    lookups = existing.Feature.LookupListIndex
    lookups.extend(index for index in record.Feature.LookupListIndex if index not in lookups)
    existing.Feature.LookupCount = len(lookups)


def _take_features(system):
    """Empties a language system taken from the shadow font and returns what it listed."""
    indices = list(system.FeatureIndex)
    system.FeatureIndex = []
    system.ReqFeatureIndex = 0xFFFF
    return indices


def _graft(font, shadow, tag):
    """Adds the shadow font's lookups, features and scripts to an existing layout table.

    A shaper uses one feature per tag in a language system, so a new feature
    whose tag is already there has its lookups added to the existing feature.
    """
    if tag not in shadow:
        return
    if tag not in font:
        font[tag] = shadow[tag]
        return
    target, extra = font[tag].table, shadow[tag].table
    if extra.LookupList is None or not extra.LookupList.Lookup:
        return
    offset = len(target.LookupList.Lookup)
    lookup_map = {index: index + offset for index in range(len(extra.LookupList.Lookup))}
    extra.LookupList.mapLookups(lookup_map)
    extra.FeatureList.mapLookups(lookup_map)
    target.LookupList.Lookup.extend(extra.LookupList.Lookup)
    target.LookupList.LookupCount = len(target.LookupList.Lookup)
    records = target.FeatureList.FeatureRecord
    placed = {}

    def give(system, extra_indices):
        for extra_index in extra_indices:
            record = extra.FeatureList.FeatureRecord[extra_index]
            same_tag = next((records[i] for i in system.FeatureIndex
                             if records[i].FeatureTag == record.FeatureTag), None)
            if same_tag is not None:
                if same_tag is not record:
                    _extend_feature(same_tag, record)
                continue
            if extra_index not in placed:
                records.append(record)
                placed[extra_index] = len(records) - 1
            system.FeatureIndex.append(placed[extra_index])
        system.FeatureCount = len(system.FeatureIndex)

    scripts = {record.ScriptTag: record.Script for record in target.ScriptList.ScriptRecord}
    for record in extra.ScriptList.ScriptRecord:
        source, script = record.Script, scripts.get(record.ScriptTag)
        default = list(source.DefaultLangSys.FeatureIndex) if source.DefaultLangSys else []
        if script is None:
            systems = [source.DefaultLangSys] + [language.LangSys for language in source.LangSysRecord]
            for system in filter(None, systems):
                give(system, _take_features(system))
            target.ScriptList.ScriptRecord.append(record)
            continue
        if source.DefaultLangSys and script.DefaultLangSys is None:
            script.DefaultLangSys = source.DefaultLangSys
            give(script.DefaultLangSys, _take_features(source.DefaultLangSys))
        elif source.DefaultLangSys:
            give(script.DefaultLangSys, default)
        languages = {language.LangSysTag: language for language in script.LangSysRecord}
        for language in source.LangSysRecord:
            existing = languages.pop(language.LangSysTag, None)
            if existing is None:
                give(language.LangSys, _take_features(language.LangSys))
                script.LangSysRecord.append(language)
            else:
                give(existing.LangSys, language.LangSys.FeatureIndex)
        # A language system does not inherit from the default, so the languages
        # the feature code did not name still need the new default features.
        for existing in languages.values():
            give(existing.LangSys, default)
        script.LangSysRecord.sort(key=lambda language: language.LangSysTag)
        script.LangSysCount = len(script.LangSysRecord)
    target.ScriptList.ScriptRecord.sort(key=lambda record: record.ScriptTag)
    target.ScriptList.ScriptCount = len(target.ScriptList.ScriptRecord)
    target.FeatureList.FeatureCount = len(records)
    sortFeatureList(target)


def _add_features(font, code):
    """Compiles feature code and adds it to the font without replacing what is there."""
    shadow = _reload(font)
    # A reload loses glyph names when the font stores none, and feature code uses them.
    shadow.setGlyphOrder(font.getGlyphOrder())
    addOpenTypeFeaturesFromString(shadow, code)
    for tag in ("GSUB", "GPOS"):
        _graft(font, shadow, tag)
    if "GDEF" in shadow:
        if "GDEF" not in font:
            font["GDEF"] = shadow["GDEF"]
        elif shadow["GDEF"].table.GlyphClassDef is not None:
            if font["GDEF"].table.GlyphClassDef is None:
                font["GDEF"].table.GlyphClassDef = shadow["GDEF"].table.GlyphClassDef
            else:
                font["GDEF"].table.GlyphClassDef.classDefs.update(shadow["GDEF"].table.GlyphClassDef.classDefs)


def _set_style_bits(font, legacy_style):
    """Keeps the bold and regular flags in step with the legacy style name."""
    bold = "Bold" in legacy_style
    os2, head = font["OS/2"], font["head"]
    italic = bool(os2.fsSelection & 0x01)
    os2.fsSelection &= ~0x60
    os2.fsSelection |= 0x20 if bold else (0 if italic else 0x40)
    head.macStyle = (head.macStyle & ~0x01) | (0x01 if bold else 0)


def _legacy_names(family, style):
    """Splits a style into a legacy family and one of the four linked styles.

    Light Italic becomes the Italic of a family called Light, so the upright
    and the italic of one weight still link.
    """
    if style in FOUR_STYLES:
        return family, style
    words = style.split()
    weight = " ".join(word for word in words if word != "Italic")
    return f"{family} {weight}".strip(), "Italic" if "Italic" in words else "Regular"


def _rename(font, family, style):
    """Renames the family, the style, or both.

    Name IDs 1 and 2 can only say Regular, Italic, Bold and Bold Italic. Any
    other style moves into the legacy family name, and IDs 16 and 17 carry the
    real pair, so applications group the faces of a family correctly.
    """
    names = font["name"]
    family = family or names.getDebugName(16) or names.getDebugName(1) or "Untitled"
    style = style or names.getDebugName(17) or names.getDebugName(2) or "Regular"
    four_style = style in FOUR_STYLES
    legacy_family, legacy_style = _legacy_names(family, style)
    postscript = "".join(ch for ch in f"{family}-{style}" if ch.isascii() and (ch.isalnum() or ch == "-"))
    values = {
        1: legacy_family,
        2: legacy_style,
        3: f"{family} {style}",
        4: f"{family} {style}",
        6: postscript,
        16: family,
        17: style,
        25: postscript.split("-")[0],
    }
    present = {record.nameID for record in names.names}
    for record in names.names:
        if record.nameID in values:
            record.string = values[record.nameID]
    if not four_style:
        for name_id in (16, 17):
            if name_id not in present:
                names.setName(values[name_id], name_id, 3, 1, 0x409)
    _set_style_bits(font, legacy_style)


def _subset(font, selection):
    """Keeps the selected characters and every glyph shaping can reach from them.

    A selection without characters keeps every glyph, so a feature set can be
    chosen on its own. An empty feature list removes all features, which is
    different from no list at all.
    """
    options = subset.Options()
    features = selection.get("features")
    options.layout_features = ["*"] if features is None else features
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = True
    subsetter = subset.Subsetter(options)
    characters = selection.get("characters")
    if characters is None:
        subsetter.populate(glyphs=font.getGlyphOrder())
    else:
        subsetter.populate(unicodes=characters)
    subsetter.subset(font)


def _entry(function):
    """Returns failures as data, so the host can report them in plain words."""
    def call(*args):
        try:
            return function(*args)
        except Exception as error:
            message = " ".join(str(error).split())
            return json.dumps({"error": message or type(error).__name__})
    return call


def _stamp(font, request):
    """Writes the modified time the request gives, so the same request gives the same bytes.

    Without one the font takes the clock's time as it is saved, as fontTools does by default.
    """
    modified_at = request.get("modifiedAt")
    if not modified_at:
        return
    try:
        moment = datetime.fromisoformat(modified_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"The modified time {modified_at} is not an ISO 8601 time.") from error
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    font["head"].modified = int(moment.timestamp()) + SECONDS_FROM_1904_TO_1970
    font.recalcTimestamp = False


def _open_source(path, request, notes):
    """Opens the source, pinned to one instance when the request names a location."""
    try:
        font = TTFont(path, fontNumber=request.get("faceIndex", 0))
    except Exception as error:
        raise ValueError(f"The source file does not open as a font: {error}") from error
    # A compressed source is unpacked here; the flavor is chosen again on saving.
    font.flavor = None
    location = request.get("location")
    if location and "fvar" in font:
        pinned = {axis.axisTag: location.get(axis.axisTag, axis.defaultValue) for axis in font["fvar"].axes}
        font = _reload(instantiateVariableFont(font, pinned, inplace=False))
        notes.append("Pinned the variable font to one instance.")
    return font


def _apply_glyph_changes(font, overrides, added, notes):
    if not overrides and not added:
        return
    if "fvar" in font:
        raise ValueError("Pin an instance of this variable font before changing its glyphs.")
    if "glyf" not in font:
        _convert_to_truetype(font, notes)
    order = font.getGlyphOrder()
    for glyph_id, override in overrides:
        if glyph_id >= len(order):
            raise ValueError(f"The source font has no glyph {glyph_id}.")
        _set_glyph(font, order[glyph_id], override.get("outline"), override.get("advance"))
    for glyph in added:
        _add_glyph(font, glyph)


@_entry
def build(request_json, source_path, output_path):
    request = json.loads(request_json)
    notes = []
    font = _open_source(source_path, request, notes)
    _apply_glyph_changes(font, request.get("overrides", []), request.get("added", []), notes)
    for code in request.get("featureCode", []):
        _add_features(font, code)
    if request.get("familyName") or request.get("styleName"):
        _rename(font, request.get("familyName"), request.get("styleName"))
    if request.get("subset"):
        font = _reload(font)
        _subset(font, request["subset"])
    font.flavor = "woff2" if request.get("flavor") == "woff2" else None
    _stamp(font, request)
    font.save(output_path)
    built = TTFont(output_path)
    return json.dumps({
        "glyphCount": len(built.getGlyphOrder()),
        "characterCount": len(built.getBestCmap() or {}),
        "notes": notes,
    })


def _number(value):
    return str(int(value)) if float(value).is_integer() else str(value)


def _master(master, opening=False):
    return f"{'The' if opening else 'the'} {master['styleName']} master"


def _lay_out_masters(source, masters):
    """Finds the one axis the masters lie along and sorts them along it.

    Returns the axis and the master that becomes the default of the rebuilt
    axis: the one at the source's default, or the nearest to it.
    """
    if "fvar" not in source:
        raise ValueError("The source font is not variable. "
                         "A variable font is rebuilt from pinned instances of a variable font.")
    if "glyf" not in source:
        raise ValueError("The source font has PostScript outlines. A variable font is rebuilt from TrueType outlines only.")
    if len(masters) < 2:
        raise ValueError("A variable font needs at least two masters. Pin another instance.")
    axes = source["fvar"].axes
    for master in masters:
        given = master.get("location") or {}
        master["location"] = {axis.axisTag: min(axis.maxValue, max(axis.minValue, given.get(axis.axisTag, axis.defaultValue)))
                              for axis in axes}
        master["styleName"] = (master.get("styleName") or "").strip() or " ".join(
            f"{tag}{_number(value)}" for tag, value in master["location"].items())
    moving = [axis for axis in axes if len({master["location"][axis.axisTag] for master in masters}) > 1]
    if len(moving) > 1:
        tags = ", ".join(axis.axisTag for axis in moving)
        raise ValueError(f"The masters differ on more than one axis ({tags}). "
                         "Pin them along one axis and keep the others the same.")
    axis = moving[0] if moving else axes[0]
    masters.sort(key=lambda master: master["location"][axis.axisTag])
    for lower, upper in zip(masters, masters[1:], strict=False):
        if lower["location"] == upper["location"]:
            place = f"{axis.axisTag} {_number(lower['location'][axis.axisTag])}"
            raise ValueError(f"{_master(lower, opening=True)} and {_master(upper)} are both at {place}. "
                             "Give each master a place of its own on the axis.")
    default = min(masters, key=lambda master: abs(master["location"][axis.axisTag] - axis.defaultValue))
    return axis, default


def _align_masters(masters):
    """Gives every master the added glyphs in one order, and refuses masters that disagree.

    The character map and the substitutions of a variable font come from one
    master, so a difference between masters would be dropped without a word.
    """
    first = masters[0]
    names = [glyph["name"] for glyph in first.setdefault("added", [])]
    code = [" ".join(part.split()) for part in first.get("featureCode", [])]
    for master in masters[1:]:
        own = {glyph["name"]: glyph for glyph in master.get("added", [])}
        lone = ([(name, first, master) for name in names if name not in own]
                + [(name, master, first) for name in own if name not in names])
        if lone:
            name, here, absent = lone[0]
            raise ValueError(f"The glyph {name} is in {_master(here)} and not in {_master(absent)}. "
                             "Add it to every master, or remove it.")
        master["added"] = [own[name] for name in names]
        for glyph, other in zip(first["added"], master["added"], strict=True):
            if sorted(set(glyph["characters"])) != sorted(set(other["characters"])):
                raise ValueError(f"The glyph {glyph['name']} maps different characters in {_master(first)} "
                                 f"and {_master(master)}. Map it to the same characters in every master.")
        if [" ".join(part.split()) for part in master.get("featureCode", [])] != code:
            raise ValueError(f"{_master(first, opening=True)} and {_master(master)} carry different feature code. "
                             "A variable font has one set of layout rules, so give every master the same feature code.")


def _segment_kinds(outline):
    return [[segment["kind"] for segment in contour["segments"]] for contour in outline["contours"]]


def _cannot_interpolate(name, detail):
    return ValueError(f"The glyph {name} cannot interpolate: it has {detail}. "
                      "Draw it with the same contours and points in every master.")


def _same_structure(name, masters, outlines):
    first, *others = [_segment_kinds(outline) for outline in outlines]
    here = _master(masters[0])
    for master, other in zip(masters[1:], others, strict=True):
        there = _master(master)
        if len(other) != len(first):
            raise _cannot_interpolate(name, f"{len(first)} contours in {here} and {len(other)} in {there}")
        for index, (a, b) in enumerate(zip(first, other, strict=True)):
            if len(a) != len(b):
                raise _cannot_interpolate(name, f"{len(a)} segments in contour {index + 1} in {here} and {len(b)} in {there}")
            differing = next(((mine, theirs) for mine, theirs in zip(a, b, strict=True) if mine != theirs), None)
            if differing:
                mine, theirs = (SEGMENT_NAMES.get(kind, kind) for kind in differing)
                raise _cannot_interpolate(name, f"{mine} in contour {index + 1} in {here} where {there} has {theirs}")


def _harmonise(name, masters, outlines, default_index):
    """Makes one glyph's outlines in every master turn the same way and carry the same points.

    Each master converted on its own could split a cubic curve into a different
    number of quadratic ones. Converting the masters' curves together gives
    every master the same number.
    """
    _same_structure(name, masters, outlines)
    reverse = _signed_area(outlines[default_index]) > 0
    for outline in outlines:
        outline["reverse"] = reverse
    for c, contour in enumerate(outlines[0]["contours"]):
        for s in range(len(contour["segments"])):
            if contour["segments"][s]["kind"] != "cubic":
                continue
            curves = []
            for outline in outlines:
                own = outline["contours"][c]
                segment = own["segments"][s]
                start = own["segments"][s - 1]["to"] if s else own["start"]
                curves.append([_point(start), _point(segment["control1"]), _point(segment["control2"]), _point(segment["to"])])
            try:
                splines = curves_to_quadratic(curves, [MAX_CURVE_ERROR] * len(curves))
            except Exception as error:
                detail = "a curve that does not convert to TrueType the same way in every master"
                raise _cannot_interpolate(name, detail) from error
            for outline, spline in zip(outlines, splines, strict=True):
                segment = outline["contours"][c]["segments"][s]
                outline["contours"][c]["segments"][s] = {"kind": "spline", "points": spline[1:], "to": segment["to"]}


def _harmonise_masters(source, masters, default_index):
    """Harmonises every glyph that all masters draw: added glyphs, and source glyphs redrawn in each."""
    for index, glyph in enumerate(masters[0]["added"]):
        _harmonise(glyph["name"], masters, [master["added"][index]["outline"] for master in masters], default_index)
    order = source.getGlyphOrder()
    redrawn = [{glyph_id: override["outline"] for glyph_id, override in master.get("overrides", []) if override.get("outline")}
               for master in masters]
    for glyph_id in redrawn[0]:
        if all(glyph_id in outlines for outlines in redrawn) and glyph_id < len(order):
            _harmonise(order[glyph_id], masters, [outlines[glyph_id] for outlines in redrawn], default_index)


def _build_master(path, request, master, notes):
    try:
        font = TTFont(path, fontNumber=request.get("faceIndex", 0))
    except Exception as error:
        raise ValueError(f"The source file does not open as a font: {error}") from error
    font.flavor = None
    font = instantiateVariableFont(font, master["location"], inplace=True)
    _apply_glyph_changes(font, master.get("overrides", []), master["added"], notes)
    glyph_order = font.getGlyphOrder()
    for code in master.get("featureCode", []):
        _add_features(font, code)
    # varLib writes the variation naming itself. A table left from the source would describe axes that are gone.
    if "STAT" in font:
        del font["STAT"]
    if master.get("featureCode"):
        # Grafting compiles the font. When a layout table overflows, fontTools wraps
        # its lookups as extensions in place and leaves them half described, which
        # the merger cannot read. A font reopened from its bytes is whole again.
        font = _reload(font)
        font.setGlyphOrder(glyph_order)
    return font


def _shape_of(font, name):
    coordinates, controls = font["glyf"]._getCoordinatesAndControls(name, font["hmtx"].metrics)
    return controls, len(coordinates) - 4


def _check_compatible(masters, fonts):
    """Refuses masters whose glyphs differ in structure.

    varLib leaves such a glyph without variation and only logs a warning, so
    the font would build and the glyph would silently stop changing.
    """
    first, order = fonts[0], fonts[0].getGlyphOrder()
    for master, font in zip(masters[1:], fonts[1:], strict=True):
        if font.getGlyphOrder() != order:
            raise ValueError(f"{_master(masters[0], opening=True)} and {_master(master)} do not have the same glyphs. "
                             "Give every master the same added glyphs.")
    for name in order:
        controls, points = _shape_of(first, name)
        for master, font in zip(masters[1:], fonts[1:], strict=True):
            other_controls, other_points = _shape_of(font, name)
            if other_controls == controls:
                continue
            if controls.numberOfContours != other_controls.numberOfContours:
                detail = (f"{max(controls.numberOfContours, 0)} contours in {_master(masters[0])} "
                          f"and {max(other_controls.numberOfContours, 0)} in {_master(master)}")
            elif points != other_points:
                detail = f"{points} points in {_master(masters[0])} and {other_points} in {_master(master)}"
            else:
                detail = f"its points arranged differently in {_master(masters[0])} and {_master(master)}"
            raise _cannot_interpolate(name, detail)


def _merge_masters(axis, axis_name, masters, fonts, default):
    tag = axis.axisTag
    values = [master["location"][tag] for master in masters]
    document = DesignSpaceDocument()
    described = AxisDescriptor()
    described.tag, described.name = tag, axis_name
    described.minimum, described.default, described.maximum = values[0], default["location"][tag], values[-1]
    document.addAxis(described)
    for master, font, value in zip(masters, fonts, values, strict=True):
        source = SourceDescriptor()
        source.font, source.location, source.styleName = font, {axis_name: value}, master["styleName"]
        document.addSource(source)
        instance = InstanceDescriptor()
        instance.styleName, instance.location = master["styleName"], {axis_name: value}
        document.addInstance(instance)
    try:
        variable, _, _ = varLib.build(document)
    except Exception as error:
        raise ValueError(f"The masters do not merge into one variable font: {error}") from error
    stops = [{"value": value, "name": master["styleName"], "flags": ELIDABLE_AXIS_VALUE if master is default else 0}
             for master, value in zip(masters, values, strict=True)]
    buildStatTable(variable, [{"tag": tag, "name": axis_name, "values": stops}], elidedFallbackName=2)
    return variable


@_entry
def build_variable(request_json, source_path, output_path):
    """Rebuilds a variable font from masters: pinned instances of one variable source, each with its own changes."""
    request = json.loads(request_json)
    notes = []
    started = time.perf_counter()
    try:
        source = TTFont(source_path, fontNumber=request.get("faceIndex", 0))
    except Exception as error:
        raise ValueError(f"The source file does not open as a font: {error}") from error
    masters = request.get("masters", [])
    axis, default = _lay_out_masters(source, masters)
    tag = axis.axisTag
    axis_name = source["name"].getDebugName(axis.axisNameID) or tag
    _align_masters(masters)
    default_index = masters.index(default)
    _harmonise_masters(source, masters, default_index)
    fonts = [_build_master(source_path, request, master, notes) for master in masters]
    built_masters = time.perf_counter()
    _check_compatible(masters, fonts)
    checked = time.perf_counter()
    _rename(fonts[default_index], request.get("familyName"), default["styleName"])
    variable = _merge_masters(axis, axis_name, masters, fonts, default)
    merged = time.perf_counter()
    variable.flavor = "woff2" if request.get("flavor") == "woff2" else None
    _stamp(variable, request)
    variable.save(output_path)
    built = TTFont(output_path)
    low, middle, high = (master["location"][tag] for master in (masters[0], default, masters[-1]))
    notes.append(f"Rebuilt the {tag} axis from {len(masters)} masters: "
                 f"{_number(low)} to {_number(high)}, with its default at {_number(middle)}.")
    notes.append("Values between two masters are interpolated in a straight line. "
                 "The source font's own axis mapping and intermediate designs are not carried over.")
    finished = time.perf_counter()

    def milliseconds(start, end):
        return round((end - start) * 1000)

    return json.dumps({
        "glyphCount": len(built.getGlyphOrder()),
        "characterCount": len(built.getBestCmap() or {}),
        "notes": list(dict.fromkeys(notes)),
        "axis": {"tag": tag, "name": axis_name, "min": low, "default": middle, "max": high},
        "timings": {"mastersMs": milliseconds(started, built_masters),
                    "checkMs": milliseconds(built_masters, checked),
                    "mergeMs": milliseconds(checked, merged),
                    "saveMs": milliseconds(merged, finished),
                    "totalMs": milliseconds(started, finished)},
    })


def _box(left, bottom, right, top, pen, clockwise):
    corners = [(left, bottom), (left, top), (right, top), (right, bottom)]
    pen.moveTo(corners[0])
    for corner in (corners[1:] if clockwise else corners[:0:-1]):
        pen.lineTo(corner)
    pen.closePath()


def _missing_glyph(units_per_em, height):
    """An empty frame, the conventional drawing for a character the font lacks."""
    width, stroke = round(units_per_em / 2), max(1, round(units_per_em / 20))
    margin = round(units_per_em / 20)
    pen = TTGlyphPen(None)
    _box(margin, 0, width - margin, height, pen, True)
    _box(margin + stroke, stroke, width - margin - stroke, height - stroke, pen, False)
    return pen.glyph(), width, margin


@_entry
def blank_font(request_json, output_path):
    """Makes a minimal font: a missing-character glyph and a space. Lettering is added to it through build."""
    request = json.loads(request_json)
    family = (request.get("familyName") or "").strip()
    style = (request.get("styleName") or "").strip() or "Regular"
    metrics = request.get("metrics") or {}
    if not family:
        raise ValueError("A blank font needs a family name.")
    units = round(metrics.get("unitsPerEm") or 0)
    if not 16 <= units <= 16384:
        raise ValueError("Units per em must be between 16 and 16384.")
    ascender, descender = round(metrics.get("ascender") or 0), round(metrics.get("descender") or 0)
    if ascender <= 0 or descender > 0:
        raise ValueError("The ascender must be above the baseline and the descender at or below it.")
    line_gap = max(0, round(metrics.get("lineGap") or 0))
    cap_height = round(metrics.get("capHeight") or min(ascender, units * 0.7))
    x_height = round(metrics.get("xHeight") or min(cap_height, units * 0.5))
    words = style.split()
    italic = "Italic" in words or "Oblique" in words
    weight = next((WEIGHT_CLASSES[word] for word in words if word in WEIGHT_CLASSES), 400)
    notdef, notdef_advance, notdef_left = _missing_glyph(units, cap_height)
    builder = FontBuilder(unitsPerEm=units, isTTF=True)
    builder.setupGlyphOrder([".notdef", "space"])
    builder.setupCharacterMap({0x20: "space"})
    builder.setupGlyf({".notdef": notdef, "space": TTGlyphPen(None).glyph()})
    builder.setupHorizontalMetrics({".notdef": (notdef_advance, notdef_left), "space": (round(units / 4), 0)})
    builder.setupHorizontalHeader(ascent=ascender, descent=descender, lineGap=line_gap)
    builder.setupNameTable({"familyName": family, "styleName": style, "uniqueFontIdentifier": family,
                            "fullName": family, "psName": family, "version": "Version 1.000"}, mac=False)
    # Bit 7 tells applications to space lines by the typographic metrics, which are the ones given.
    builder.setupOS2(sTypoAscender=ascender, sTypoDescender=descender, sTypoLineGap=line_gap,
                     usWinAscent=ascender, usWinDescent=-descender, sCapHeight=cap_height, sxHeight=x_height,
                     usWeightClass=weight, fsType=0, fsSelection=0x80 | (0x01 if italic else 0), version=4)
    builder.setupPost()
    font = builder.font
    font["head"].created = font["head"].modified = BLANK_FONT_TIMESTAMP
    font["head"].macStyle = 0x02 if italic else 0
    font.recalcTimestamp = False
    _rename(font, family, style)
    font.save(output_path)
    built = TTFont(output_path)
    return json.dumps({
        "glyphCount": len(built.getGlyphOrder()),
        "characterCount": len(built.getBestCmap() or {}),
        "notes": [],
    })


def _substitutions(lookup, limit):
    found = []
    for subtable in lookup.SubTable:
        actual = getattr(subtable, "ExtSubTable", subtable)
        kind = type(actual).__name__
        if kind == "SingleSubst":
            found += [{"kind": "single", "from": a, "to": b} for a, b in actual.mapping.items()]
        elif kind == "LigatureSubst":
            for first, ligatures in actual.ligatures.items():
                found += [{"kind": "ligature", "from": [first, *lig.Component], "to": lig.LigGlyph} for lig in ligatures]
        elif kind == "AlternateSubst":
            found += [{"kind": "alternate", "from": a, "to": list(b)} for a, b in actual.alternates.items()]
        elif kind == "MultipleSubst":
            found += [{"kind": "multiple", "from": a, "to": list(b)} for a, b in actual.mapping.items()]
        if len(found) > limit:
            break
    return found


def _count_positioning(table):
    pairs = anchors = 0
    for lookup in table.LookupList.Lookup:
        for subtable in lookup.SubTable:
            actual = getattr(subtable, "ExtSubTable", subtable)
            kind = type(actual).__name__
            if kind == "PairPos":
                if actual.Format == 1:
                    pairs += sum(len(pair_set.PairValueRecord) for pair_set in actual.PairSet)
                else:
                    pairs += sum(1 for row in actual.Class1Record for cell in row.Class2Record
                                 if cell.Value1 is not None or cell.Value2 is not None)
            elif kind in ("MarkBasePos", "MarkLigPos", "MarkMarkPos"):
                marks = getattr(actual, "MarkArray", None) or getattr(actual, "Mark1Array", None)
                anchors += len(marks.MarkRecord) if marks else 0
    return pairs, anchors


@_entry
def describe_layout(path, face_index):
    font = TTFont(path, fontNumber=face_index)
    features, pairs, anchors = [], 0, 0
    for tag in ("GSUB", "GPOS"):
        if tag not in font or font[tag].table.FeatureList is None:
            continue
        table = font[tag].table
        scripts_by_feature = {}
        for script in table.ScriptList.ScriptRecord:
            systems = [script.Script.DefaultLangSys] + [record.LangSys for record in script.Script.LangSysRecord]
            for system in filter(None, systems):
                for index in system.FeatureIndex:
                    scripts_by_feature.setdefault(index, set()).add(script.ScriptTag)
        merged = {}
        for index, record in enumerate(table.FeatureList.FeatureRecord):
            entry = merged.setdefault(record.FeatureTag, {"lookups": [], "scripts": set()})
            entry["lookups"] += [i for i in record.Feature.LookupListIndex if i not in entry["lookups"]]
            entry["scripts"] |= scripts_by_feature.get(index, set())
        for feature_tag, entry in sorted(merged.items()):
            substitutions = []
            if tag == "GSUB":
                for index in entry["lookups"]:
                    substitutions += _substitutions(table.LookupList.Lookup[index], SUBSTITUTION_LIMIT)
            features.append({
                "tag": feature_tag,
                "table": tag,
                "scripts": sorted(entry["scripts"]),
                "lookupCount": len(entry["lookups"]),
                "substitutions": substitutions[:SUBSTITUTION_LIMIT],
                "truncated": len(substitutions) > SUBSTITUTION_LIMIT,
            })
        if tag == "GPOS":
            pairs, anchors = _count_positioning(table)
    return json.dumps({
        "glyphNames": font.getGlyphOrder(),
        "features": features,
        "kerningPairCount": pairs,
        "anchorCount": anchors,
    })


def _parse_tables(font, report):
    """Decompiles every table in full and reports each one that fails."""
    sound = True
    for tag in font.keys():
        try:
            table = font[tag]
            if hasattr(table, "ensureDecompiled"):
                table.ensureDecompiled()
        except Exception as error:
            sound = False
            detail = " ".join(f"{type(error).__name__}: {error}".split())
            report("error", f"The {tag.strip()} table is damaged and cannot be read ({detail}).", tag)
    return sound


def _check_layout(font, report):
    for tag in ("GSUB", "GPOS"):
        if tag not in font or font[tag].table.FeatureList is None:
            continue
        table = font[tag].table
        lookup_count = len(table.LookupList.Lookup) if table.LookupList else 0
        for record in table.FeatureList.FeatureRecord:
            if any(index >= lookup_count for index in record.Feature.LookupListIndex):
                report("error", f"Feature {record.FeatureTag} points at a lookup that does not exist.", tag)


def _check_structure(font, report):
    """Checks that the tables agree with each other. Needs every table to have parsed."""
    for tag in REQUIRED_TABLES:
        if tag not in font:
            report("error", f"The required {tag} table is missing.", tag)
    if "glyf" not in font and "CFF " not in font and "CFF2" not in font:
        report("error", "The font has no outline table.")
    order = font.getGlyphOrder()
    characters = font.getBestCmap() if "cmap" in font else None
    if not characters:
        report("warning", "The font maps no Unicode characters.", "cmap")
    known = set(order)
    for code, name in (characters or {}).items():
        if name not in known:
            report("error", f"U+{code:04X} maps to a glyph that does not exist.", "cmap")
    if "maxp" in font and font["maxp"].numGlyphs != len(order):
        report("error", "The glyph count does not match the glyph order.", "maxp")
    if "hmtx" in font:
        missing = [name for name in order if name not in font["hmtx"].metrics]
        if missing:
            report("error", f"{len(missing)} glyphs have no advance width.", "hmtx")
    if "head" in font and not 16 <= font["head"].unitsPerEm <= 16384:
        report("error", "Units per em is outside the range 16 to 16384.", "head")
    if "name" in font and not (font["name"].getDebugName(1) or font["name"].getDebugName(16)):
        report("warning", "The font has no family name.", "name")
    _check_layout(font, report)
    try:
        _reload(font)
    except Exception as error:
        report("error", f"The font does not save and reload: {error}")
    return len(order), len(characters or {})


@_entry
def validate(path):
    issues = []

    def report(severity, message, table=None):
        issues.append({"severity": severity, "table": table, "message": message})

    glyph_count = character_count = 0
    try:
        # fontTools would otherwise swap a table it cannot read for raw bytes and carry on.
        font = TTFont(path, ignoreDecompileErrors=False)
    except Exception as error:
        report("error", f"The file does not open as a font: {error}")
    else:
        try:
            if _parse_tables(font, report):
                glyph_count, character_count = _check_structure(font, report)
        except Exception as error:
            report("error", f"The font's tables do not agree with each other: {error}")
    return json.dumps({
        "loadable": not any(issue["severity"] == "error" for issue in issues),
        "glyphCount": glyph_count,
        "characterCount": character_count,
        "issues": issues,
    })
