"""Font construction engine.

Runs fontTools inside Pyodide, in a browser worker or in Node. The host writes
the source font to a file, calls one of the entry points with a JSON request,
and reads the result file. Entry points: build, describe_layout, validate.
"""

import io
import json
import unicodedata

import fontTools.merge  # noqa: F401  registers mapLookups and mapFeatures on layout tables
from fontTools import subset
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
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
FOUR_STYLES = ("Regular", "Italic", "Bold", "Bold Italic")


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
    """Draws an outline as a TrueType glyph: quadratic curves, clockwise outside."""
    pen = TTGlyphPen(None)
    target = Cu2QuPen(pen, MAX_CURVE_ERROR)
    if _signed_area(outline) > 0:
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
    font.save(output_path)
    built = TTFont(output_path)
    return json.dumps({
        "glyphCount": len(built.getGlyphOrder()),
        "characterCount": len(built.getBestCmap() or {}),
        "notes": notes,
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
