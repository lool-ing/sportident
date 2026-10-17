# Station identity captures — bench, 2026-06-01

Six coupled units read with `probe --info`, each paired with the **physically
printed label** (model + serial). This cross-product cracked the two encodings
that were unverified before: **serial** and **mode**. Both now match 6/6 exactly.

## Verified decodings (from this capture set)

- **Serial number** = `uint32` **big-endian** at config address **`0x00..0x03`**.
  All six decode to the exact printed serial. The trailing `ff 36 35 36`
  ("656") at `0x04..0x07` is a CONSTANT on every unit — NOT part of the serial.
- **Operating mode** = config byte **`0x71`**, **low nibble** = SI mode enum:
  Control=2, Start=3, Finish=4, Clear=7, Check=10 (0x0A). Proven by the Swedish
  labels: `töm`→Clear(7), `mål`→Finish(4), `start`→Start(3), `check`→Check(10).
  The two numbered controls additionally carry `0x30` in the high nibble
  (flag bits, meaning TBD — does not affect mode identification).
- **Code number** (low byte) = config byte **`0x72`** — confirmed again on all 6,
  and matches the `0x1C` reply header CN1 CN0.

## Still unmapped

- **Model / firmware** (BSF8 vs BSF9): unit 110 is a BSF9, the other five are
  BSF8 (start unknown). Their `0x70` and `0x00` windows are identical apart from
  code + serial, so the model/firmware id lives at an address not yet read.
  Low priority — not needed for the config menu.

## Raw captures

`--info` reads two 8-byte windows: serial at `0x00`, mode/code at `0x70`.
The `0x1C` line is the identity / backup-pointer reply.

### 110 — BSF9, serial 589578 (numbered control)

```
identity 0x1C : 02 83 0a 00 6e 1c 00 00 18 04 ff 02 a8 1a 75 03
raw 0x00      : 00 08 ff 0a ff 36 35 36   -> serial 0x0008ff0a = 589578 ✓
raw 0x70      : 38 32 6e 37 01 19 06 10   -> mode 0x32 (low=2 Control +0x30), code 0x6e=110
```

### 136 — BSF8, serial 184723 (numbered control)

```
identity 0x1C : 02 83 0a 00 88 1c 00 00 18 04 ff 02 b0 6b 69 03
raw 0x00      : 00 02 d1 93 ff 36 35 36   -> serial 0x0002d193 = 184723 ✓
raw 0x70      : 38 32 88 37 01 19 06 10   -> mode 0x32 (low=2 Control +0x30), code 0x88=136
```

### mål (finish) — BSF8, serial 183624, code 10

```
identity 0x1C : 02 83 0a 00 0a 1c 00 00 18 04 ff 01 30 de a0 03
raw 0x00      : 00 02 cd 48 ff 36 35 36   -> serial 0x0002cd48 = 183624 ✓
raw 0x70      : 38 04 0a 37 01 1a 05 13   -> mode 0x04 = Finish ✓, code 0x0a=10
```

### töm (clear) — BSF8, serial 120073, code 1

```
identity 0x1C : 02 83 0a 00 01 1c 00 00 18 04 ff 03 e8 e9 d0 03
raw 0x00      : 00 01 d5 09 ff 36 35 36   -> serial 0x0001d509 = 120073 ✓
raw 0x70      : 38 07 01 37 01 1a 05 13   -> mode 0x07 = Clear ✓, code 0x01=1
```

### start — model unknown, serial 85702, code 3

```
identity 0x1C : 02 83 0a 00 03 1c 00 00 18 04 ff 03 c8 e5 d0 03
raw 0x00      : 00 01 4e c6 ff 36 35 36   -> serial 0x00014ec6 = 85702 ✓
raw 0x70      : 30 03 03 37 01 1a 05 13   -> mode 0x03 = Start ✓, code 0x03=3
```

(Note: start's `0x70` byte is `30`, not `38` like the others — another flag
that varies; harmless to mode/serial/code decode.)

### check — BSF8, serial 118675, code 2 (the kvar-i-skogen unit)

```
identity 0x1C : 02 83 0a 00 02 1c 00 00 18 04 ff 04 40 f2 80 03
raw 0x00      : 00 01 cf 93 ff 36 35 36   -> serial 0x0001cf93 = 118675 ✓
raw 0x70      : 38 0a 02 37 01 1a 05 13   -> mode 0x0a = Check ✓, code 0x02=2
```
