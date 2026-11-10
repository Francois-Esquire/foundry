"""Independent validation of a built font, outside the app's own engine.

    uv run --no-project --with fonttools --with opentype-sanitizer \
        python -I scripts/validate-font.py <font> \
        [--expect-chars U+0041,U+0915] [--shape "text"]

The app builds fonts with fontTools on Pyodide and reads them with HarfBuzz
compiled to WebAssembly. This script asks two other implementations: native
fontTools, which must decompile and recompile every table, and the OpenType
Sanitizer, the parser browsers put in front of web fonts. It prints one JSON
report and exits 0 when the font is accepted, 1 when it is not.

A WOFF2 file is unpacked by the sanitizer, which has its own decoder, and
fontTools then reads what the sanitizer wrote. So no Brotli module is needed,
and the unpacking is checked by a tool other than the one that packed it.

Shaping needs a shaper, which the command above does not install. Add
`--with uharfbuzz` to have --shape answered; without it the report says the
shaping check was unavailable instead of guessing from the character map.
"""

import argparse
import io
import json
import sys
import tempfile
from pathlib import Path

import fontTools
import ots
from fontTools.ttLib import TTFont

WOFF2_SIGNATURE = b"wOF2"


def _explain(error):
    return " ".join(f"{type(error).__name__}: {error}".split())


def _parse_characters(text):
    """Reads U+0041,U+0915 into code points."""
    return [int(part.strip().upper().removeprefix("U+"), 16) for part in text.split(",") if part.strip()]


def _recompile_tables(font):
    """Decompiles and recompiles each table on its own, so one bad table is named."""
    problems = []
    for tag in font.keys():
        try:
            table = font[tag]
            if hasattr(table, "ensureDecompiled"):
                table.ensureDecompiled()
            if tag != "GlyphOrder":
                table.compile(font)
        except Exception as error:
            problems.append({"table": tag, "message": _explain(error)})
    return problems


def _round_trip(font):
    """Saves the whole font and reopens it. The glyphs and character map must survive."""
    buffer = io.BytesIO()
    font.flavor = None
    font.save(buffer)
    buffer.seek(0)
    again = TTFont(buffer, ignoreDecompileErrors=False)
    if again.getGlyphOrder() != font.getGlyphOrder():
        return [{"table": None, "message": "The glyph order changed after saving and reopening."}]
    if again.getBestCmap() != font.getBestCmap():
        return [{"table": "cmap", "message": "The character map changed after saving and reopening."}]
    return []


def check_with_fonttools(path):
    """Opens the font strictly: fontTools would otherwise keep a table it cannot read as raw bytes."""
    report = {"version": fontTools.version, "accepted": False, "problems": []}
    try:
        font = TTFont(path, ignoreDecompileErrors=False)
        report["problems"] = _recompile_tables(font)
        if not report["problems"]:
            report["problems"] = _round_trip(font)
    except Exception as error:
        report["problems"].append({"table": None, "message": _explain(error)})
        return report, None
    if report["problems"]:
        return report, None
    names = font["name"]
    report.update(
        accepted=True,
        tables=sorted(tag for tag in font.keys() if tag != "GlyphOrder"),
        glyphCount=len(font.getGlyphOrder()),
        characterCount=len(font.getBestCmap() or {}),
        familyName=names.getDebugName(16) or names.getDebugName(1),
        styleName=names.getDebugName(17) or names.getDebugName(2),
        axes=[axis.axisTag for axis in font["fvar"].axes] if "fvar" in font else [],
    )
    return report, font


def _tables_in(path):
    try:
        return {tag for tag in TTFont(path).keys() if tag != "GlyphOrder"}
    except Exception:
        return None


def check_with_sanitizer(path, output):
    """Runs ots-sanitize, writing the sanitized font to `output`.

    The sanitizer can discard a table it rejects and still report success, and
    a browser would then draw the font without it. A table that was discarded
    with a message counts as a rejection. Tables it does not know are passed
    over silently, which is harmless, so they are only listed. The comparison
    needs fontTools to list the tables of the file as given, which it cannot
    do for WOFF2 without Brotli; then only the messages are judged.
    """
    version = ots.sanitize("--version", capture_output=True).stdout.decode().strip()
    result = ots.sanitize(str(path), str(output), capture_output=True)
    messages = [line for line in result.stderr.decode(errors="replace").splitlines() if line.strip()]
    sanitized = result.returncode == 0
    given, kept = _tables_in(path), _tables_in(output) if sanitized else None
    missing = sorted(given - kept) if given is not None and kept is not None else []
    blamed = [tag for tag in missing if any(f"{tag.strip()}:" in message for message in messages)]
    errors = [message for message in messages if message.startswith("ERROR")]
    return {
        "version": version,
        "accepted": sanitized and not blamed and not errors,
        "messages": messages,
        "discardedTables": blamed,
        "passedOverTables": [tag for tag in missing if tag not in blamed],
    }


def check_characters(font, expected):
    mapped = font.getBestCmap() or {}
    missing = [code for code in expected if code not in mapped]
    return {
        "accepted": not missing,
        "expected": len(expected),
        "missing": [f"U+{code:04X}" for code in missing],
    }


def shape(path, text):
    """Shapes with native HarfBuzz when it is installed. Clusters count code points."""
    try:
        import uharfbuzz
    except ImportError:
        return {"available": False, "reason": "No shaper is installed. Add --with uharfbuzz to shape text."}
    face = uharfbuzz.Face(uharfbuzz.Blob.from_file_path(str(path)))
    font = uharfbuzz.Font(face)
    buffer = uharfbuzz.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    uharfbuzz.shape(font, buffer)
    glyphs = [
        {"name": font.glyph_to_string(info.codepoint), "cluster": info.cluster, "advance": position.x_advance}
        for info, position in zip(buffer.glyph_infos, buffer.glyph_positions, strict=True)
    ]
    return {"available": True, "engine": f"HarfBuzz {uharfbuzz.version_string()}", "text": text, "glyphs": glyphs}


def validate(path, expected, text):
    report = {"font": str(path), "packed": path.read_bytes()[:4] == WOFF2_SIGNATURE}
    with tempfile.TemporaryDirectory() as directory:
        sanitized = Path(directory) / "sanitized.ttf"
        report["sanitizer"] = check_with_sanitizer(path, sanitized)
        plain = sanitized if report["packed"] else path
        if plain.is_file():
            report["fontTools"], font = check_with_fonttools(plain)
        else:
            problem = "The sanitizer could not unpack the WOFF2 file, so there was nothing to read."
            report["fontTools"], font = {"accepted": False, "problems": [{"table": None, "message": problem}]}, None
        verdicts = [report["fontTools"]["accepted"], report["sanitizer"]["accepted"]]
        if expected and font is not None:
            report["characters"] = check_characters(font, expected)
            verdicts.append(report["characters"]["accepted"])
        if text and font is not None:
            report["shaping"] = shape(plain, text)
        elif text:
            report["shaping"] = {"available": False, "reason": "Only a font that opens can be shaped."}
    report["accepted"] = all(verdicts)
    return report


def main():
    parser = argparse.ArgumentParser(description="Validate a font with native fontTools and the OpenType Sanitizer.")
    parser.add_argument("font", type=Path)
    parser.add_argument("--expect-chars", default="", help="Characters the font must map, for example U+0041,U+0915.")
    parser.add_argument("--shape", default="", help="Text to shape, when a shaper is installed.")
    arguments = parser.parse_args()
    report = {"font": str(arguments.font), "accepted": False}
    try:
        expected = _parse_characters(arguments.expect_chars)
    except ValueError:
        report["error"] = "Write --expect-chars as code points with commas between them, for example U+0041,U+0915."
    else:
        if arguments.font.is_file():
            report = validate(arguments.font, expected, arguments.shape)
        else:
            report["error"] = "There is no file at this path."
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if report["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
