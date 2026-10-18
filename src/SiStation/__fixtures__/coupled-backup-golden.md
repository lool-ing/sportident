# Golden hardware capture — coupled BSF8 backup read

Captured 2026-06-01 from a real BSF8 check unit inductively coupled on a
BSM7-USB master, via `scripts/probe-coupled-backup.ts --raw`. Station had to be
woken with a card dip first. These bytes are the ground truth for the
readBackup parser rewrite (the original parser was written against a mock with
a fictional layout and never matched real hardware).

## GET_SYS_VAL backup pointer — request `[0x1C, 0x07]`

TX: `ff 02 83 02 1c 07 74 06 03`
RX: `02 83 0a 00 02 1c 00 00 18 04 ff 04 28 73 f3 03`

Parsed params (parse() → slice(3, 3+0x0a)):
`[00 02 1c 00 00 18 04 ff 04 28]`
= CN1=00 CN0=02 ADDR=1c | data(7) = `00 00 18 04 ff 04 28`

Spec §3.1: the 7 data bytes are `EP3 EP2 xx xx xx EP1 EP0`.
EP3=00 EP2=00 xx=18 xx=04 xx=ff EP1=04 EP0=28
=> backup pointer = 0x00000428 = 1064 (ABSOLUTE next-free address; data lives
from 0x100 up to 0x428).

## GET_BACKUP first block — request `[0x00, 0x01, 0x00, 0x80]` (addr 0x000100, len 128)

TX: `ff 02 81 04 00 01 00 80 fa 7f 03`
RX (3 chunks, reassembled):
`02 81 85 00 02 00 01 00 1a 22 e1 69 69 54 37 54 1e 4b a7 69 69 54 46 09 0f dd ae 69 69 54 4b a2 84 c2 c9 69 69 55 47 12 01 41 3a 69 69 56 21 0a 18 54 ee 69 69 56 2a c0 84 c2 c9 69 69 56 99 fa 04 97 d8 69 69 56 b9 b3 19 5b ed 69 69 57 11 66 87 d9 de 69 69 57 7e fd 88 f4 d8 69 69 57 89 ad 84 c2 c9 69 69 57 8c e1 0c d7 71 69 69 57 96 58 2d 58 fa 69 69 57 dc ee 28 0a bb 69 69 57 e1 2b 2a 20 ba 69 69 57 e4 c2 de 30 03`

command=0x81, numParameters=0x85=133.
params = 5-byte header `00 02 00 01 00` (CN1 CN0 ADR2 ADR1 ADR0) + 128 data bytes.

## Record layout (empirically confirmed)

8-byte records, oldest first. Each record:
bytes 0..2 : SI card number, big-endian (3 bytes)
bytes 3..4 : DATE1 DATE0 (here `69 69` = 2026-05-20, pm)
bytes 5..6 : TH TL, seconds in the 12-hour half day (0..43199)
byte 7 : MS, 1/256 s

Source: SPORTident PC Programmer's Guide 5, backup memory data format
(extended-protocol flag set, firmware 5.55+). DATE1 bits 7-2 = year (2000+),
bits 1-0 = month bits 3-2; DATE0 bits 7-6 = month bits 1-0, bits 5-1 = day,
bit 0 = pm. The 6-byte record of the flag-off format is not covered.
Bytes 5..7 read as one big-endian number (`rawTime`) rise here only because
all 16 punches fall in the same half day; across noon it jumps back.

16 records in this block (card = bytes 0..2 BE):
1 1a 22 e1 = 1712865
2 1e 4b a7 = 1985447
3 0f dd ae = 1039790
4 84 c2 c9 = 8700617 <-- appears 3x: r4, r7, r12
5 01 41 3a = 82234
6 18 54 ee = 1594606
7 84 c2 c9 = 8700617 <-- repeat
8 04 97 d8 = 301016
9 19 5b ed = 1661933
10 87 d9 de = 8903134
11 88 f4 d8 = 8975576
12 84 c2 c9 = 8700617 <-- repeat
13 0c d7 71 = 841585
14 2d 58 fa = 2971898
15 28 0a bb = 2624187
16 2a 20 ba = 2760890

Cross-check: card 8700617 punched the start
check 3×. The first-3-bytes-BE decode is correct for these cards (all
≤ 0x98967F = 9999999, fit in 3 bytes). NOTE: revisit if a station holds SIAC/8-digit cards
that exceed 3 bytes.

## Bugs in the ORIGINAL readBackup.ts this capture exposes

1. Pointer request sent `[0x00,0x00,0x80]` (3 params) → firmware read NUM=0 →
   returned no data → pointer parsed as 0 → "empty backup, no error". This was
   the user-visible "nothing happens". CORRECT: `[0x1C, 0x07]`.
2. GET_SYS_VAL response indexed at absolute offset 0x1C into the params array,
   but the real reply is just `CN1 CN0 ADDR + 7 data bytes` — the pointer is in
   the 7 data bytes, not at array index 0x1C.
3. GET_BACKUP response has a 5-byte header (`CN1 CN0 ADR2 ADR1 ADR0`) before the
   128 data bytes; parseBackupBlock parsed from byte 0 → ate the header.
4. Record card number read at offset BC_CN=3 (4 bytes) — real layout is bytes
   0..2. The mock encoded the fictional offset-3 layout, so tests passed.
5. Block loop started at address 0x00 (station config), not 0x100, and treated
   the pointer as a byte-count-from-0 rather than an absolute end address.
