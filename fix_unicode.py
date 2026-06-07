#!/usr/bin/env python3
"""Fix parse5 control-character warning by replacing only the problematic characters.
The issue is that index.html contains raw UTF-8 bytes that parse5 treats as control characters.
We need to replace emoji and special symbols with ASCII-safe HTML entities, but NOT
create numeric references to control characters (0x00-0x1F, 0x80-0x9F)."""
from collections import Counter

filepath = r'D:\Projects\Vault-app\index.html'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Only replace ACTUAL emoji/special symbols (U+2000 and above) with named entities.
# DO NOT touch anything below U+2000 — those are likely UTF-8 mojibake artifacts
# that should be cleaned differently.

replacements = [
    (0x2026, '&hellip;'),    # … HORIZONTAL ELLIPSIS
    (0x2019, '&rsquo;'),     # ' RIGHT SINGLE QUOTATION MARK
    (0x2018, '&lsquo;'),     # ' LEFT SINGLE QUOTATION MARK
    (0x201C, '&ldquo;'),     # " LEFT DOUBLE QUOTATION MARK
    (0x201D, '&rdquo;'),     # " RIGHT DOUBLE QUOTATION MARK
    (0x2013, '&ndash;'),     # – EN DASH
    (0x2014, '&mdash;'),     # — EM DASH
    (0x00B7, '&middot;'),    # · MIDDLE DOT (borderline, but safe named entity)
    (0x2195, '&#x2195;'),    # ↕ UP DOWN ARROW
    (0x2190, '&larr;'),      # ← LEFTWARDS ARROW
    (0x2191, '&uarr;'),      # ↑ UPWARDS ARROW
    (0x2192, '&rarr;'),      # → RIGHTWARDS ARROW
    (0x2193, '&darr;'),      # ↓ DOWNWARDS ARROW
    (0x21A9, '&#x21A9;'),    # ↩ LEFTWARDS ARROW WITH HOOK
    (0x2B05, '&#x2B05;'),    # ⬅ LEFTWARDS BLACK ARROW
    (0x2B06, '&#x2B06;'),    # ⬆ UPWARDS BLACK ARROW
    (0x2B07, '&#x2B07;'),    # ⬇ DOWNWARDS BLACK ARROW
    (0x25B6, '&#x25B6;'),    # ▶ BLACK RIGHT-POINTING TRIANGLE
    (0x25C0, '&#x25C0;'),    # ◀ BLACK LEFT-POINTING TRIANGLE
    (0x203A, '&#x203A;'),    # › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    (0x2039, '&#x2039;'),    # ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
    (0x2022, '&bull;'),      # • BULLET
    (0x2714, '&#x2714;'),    # ✔ HEAVY CHECK MARK
    (0x2713, '&#x2713;'),    # ✓ CHECK MARK
    (0x2705, '&#x2705;'),    # ✅ WHITE HEAVY CHECK MARK
    (0x274C, '&#x274C;'),    # ❌ CROSS MARK
    (0x2716, '&#x2716;'),    # ✖ HEAVY MULTIPLICATION X
    (0x2718, '&#x2718;'),    # ✘ HEAVY BALLOT X
    (0x23F3, '&#x23F3;'),    # ⏳ HOURGLASS WITH FLOWING SAND
    (0x2009, '&#x2009;'),    # THIN SPACE
    (0x00A0, '&nbsp;'),      # NO-BREAK SPACE
    # Emoji range U+1F300–U+1FAFF — replace with empty string or text
]

# First pass: handle known replacements
total = 0
for codepoint, entity in replacements:
    char = chr(codepoint)
    count = content.count(char)
    if count > 0:
        print(f'  U+{codepoint:04X} x{count} -> {entity}')
        content = content.replace(char, entity)
        total += count

# Second pass: catch ANY remaining chars above U+2000 (symbols, emoji, etc.)
remaining = []
for ch in content:
    cp = ord(ch)
    if cp >= 0x2000:
        remaining.append(ch)

if remaining:
    print(f'\n  Remaining U+2000+ chars ({len(remaining)}):')
    cnt = Counter(remaining)
    for ch, c in cnt.most_common():
        cp = ord(ch)
        entity = f'&#x{cp:X};'
        print(f'    U+{cp:04X} x{c} -> {entity}')
        content = content.replace(ch, entity)
        total += c

# Check for truly problematic control characters (U+0000-U+001F except tab/newline/CR)
control_chars = []
for ch in content:
    cp = ord(ch)
    if cp < 0x20 and cp not in (0x09, 0x0A, 0x0D):
        control_chars.append(cp)
    elif 0x7F <= cp <= 0x9F:
        control_chars.append(cp)

if control_chars:
    print(f'\n  WARNING: Found {len(control_chars)} control characters:')
    for cp in sorted(set(control_chars)):
        print(f'    U+{cp:04X}')
    # Remove them
    for cp in sorted(set(control_chars)):
        content = content.replace(chr(cp), '')
    print(f'  Removed all control characters.')

print(f'\nTotal replacements: {total}')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done.')
