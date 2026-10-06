"""Installed fonts for the caption font picker.

The panel draws captions with Chromium's canvas, which can use any font
installed on this machine by family name — it just needs to know which
families exist. This reads the family name + weight straight from each
font file's ``name`` / ``OS/2`` tables (no fontTools dependency), for the
Windows system and per-user font folders (plus macOS/Linux dirs, so tests
and non-Windows dev boxes work).
"""
from __future__ import annotations

import logging
import os
import struct
from pathlib import Path

logger = logging.getLogger(__name__)

_EXTS = {".ttf", ".otf", ".ttc"}
_cache: list[dict] | None = None


def font_dirs() -> list[Path]:
    dirs: list[Path] = []
    windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
    if windir:
        dirs.append(Path(windir) / "Fonts")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        dirs.append(Path(local) / "Microsoft" / "Windows" / "Fonts")   # per-user installs
    home = Path.home()
    dirs += [Path("/System/Library/Fonts"), Path("/Library/Fonts"), home / "Library" / "Fonts",
             Path("/usr/share/fonts"), Path("/usr/local/share/fonts"),
             home / ".local" / "share" / "fonts", home / ".fonts"]
    return [d for d in dirs if d.is_dir()]


def _tables(data: bytes, offset: int) -> dict[str, tuple[int, int]]:
    num = struct.unpack_from(">H", data, offset + 4)[0]
    out = {}
    for i in range(num):
        tag, _cs, off, length = struct.unpack_from(">4sIII", data, offset + 12 + 16 * i)
        out[tag.decode("latin-1")] = (off, length)
    return out


def _names(data: bytes, off: int) -> tuple[dict[int, str], bool]:
    """nameID → string (English preferred) and whether it's a symbol font."""
    _fmt, count, str_off = struct.unpack_from(">HHH", data, off)
    best: dict[int, tuple[int, str]] = {}
    symbol = False
    for i in range(count):
        pid, eid, lid, nid, length, noff = struct.unpack_from(">HHHHHH", data, off + 6 + 12 * i)
        if nid not in (1, 2, 16, 17):
            continue
        raw = data[off + str_off + noff: off + str_off + noff + length]
        if pid == 3:
            if eid == 0:
                symbol = True
            text = raw.decode("utf-16-be", errors="ignore")
            rank = 0 if lid == 0x409 else 1
        elif pid == 1 and eid == 0:
            text = raw.decode("mac_roman", errors="ignore")
            rank = 2
        else:
            continue
        if text and (nid not in best or rank < best[nid][0]):
            best[nid] = (rank, text)
    return {k: v[1] for k, v in best.items()}, symbol


def read_font_faces(path: Path) -> list[dict]:
    """[{family, weight, italic}] for every face in a .ttf/.otf/.ttc."""
    data = path.read_bytes()
    offsets = [0]
    if data[:4] == b"ttcf":
        n = struct.unpack_from(">I", data, 8)[0]
        offsets = list(struct.unpack_from(">" + "I" * n, data, 12))
    faces = []
    for base in offsets:
        tables = _tables(data, base)
        if "name" not in tables:
            continue
        names, symbol = _names(data, tables["name"][0])
        family = names.get(16) or names.get(1)
        if not family or symbol or family.startswith("@"):
            continue
        weight, italic = 400, False
        if "OS/2" in tables:
            o = tables["OS/2"][0]
            weight = struct.unpack_from(">H", data, o + 4)[0] or 400
            italic = bool(struct.unpack_from(">H", data, o + 62)[0] & 1)
        sub = (names.get(17) or names.get(2) or "").lower()
        italic = italic or "italic" in sub or "oblique" in sub
        faces.append({"family": family.strip(), "weight": max(100, min(900, round(weight / 100) * 100)),
                      "italic": italic})
    return faces


def list_system_fonts(refresh: bool = False) -> list[dict]:
    """Sorted [{family, weights: [...]}] of upright installed fonts. Cached."""
    global _cache
    if _cache is not None and not refresh:
        return _cache
    families: dict[str, set[int]] = {}
    for d in font_dirs():
        for p in d.rglob("*"):
            if p.suffix.lower() not in _EXTS or not p.is_file():
                continue
            try:
                for f in read_font_faces(p):
                    if not f["italic"]:
                        families.setdefault(f["family"], set()).add(f["weight"])
            except Exception as exc:  # noqa: BLE001 — one bad font must not hide the rest
                logger.debug("font skipped %s: %s", p, exc)
    _cache = [{"family": k, "weights": sorted(v)} for k, v in
              sorted(families.items(), key=lambda kv: kv[0].lower())]
    return _cache
