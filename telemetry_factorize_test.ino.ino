// Image telemetry protocol debug test — RGB565 Tile 24×24
// Target: Arduino Leonardo (ATmega32U4) — 2.5KB SRAM, 32KB Flash
//
// Codec 3 (Tile): 6×6 grid → 36 blocks of 4×4 pixels (32B each)
//   I-frame: RAW (Codec=0) every KEYFRAME_INTERVAL frames
//   P-frame: Tile (Codec=3) — only changed blocks transmitted
//   Block comparison via 1-byte XOR hash

#include <Arduino.h>

#define IMG_W  32
#define IMG_H  32

#define ROM_TOTAL 32768U
#define RAM_TOTAL 2560U

// ── Tile constants ─────────────────────────────────────────────────
#define TILE_GRID    8      // 8×8 blocks
#define TILE_PX      4      // pixels per block side (32/8)
#define TILE_BYTES   (TILE_PX * TILE_PX * 2)  // 32 bytes per block
#define TILE_COUNT   (TILE_GRID * TILE_GRID)   // 64 blocks
#define KEYFRAME_INTERVAL 16

// ── HEATSHRINK constants (preserved) ───────────────────────────────
// #define HSE_WINDOW_SZ2     8
// #define HSE_LOOKAHEAD_SZ2  4
// #define HSE_WINDOW_SIZE    (1U << HSE_WINDOW_SZ2)
// #define HSE_LOOKAHEAD_MAX  (1U << HSE_LOOKAHEAD_SZ2)
// #define HSE_MIN_MATCH      2

// ── Globals ───────────────────────────────────────────────────────
static uint16_t img[IMG_W * IMG_H];        // frame buffer 24*24*2 = 1152B
static uint8_t  prev_hash[TILE_COUNT];     // 36B — per-block XOR hash of previous frame
static uint8_t  changed_mask[8];           // bitmap of changed tiles (8B = 64 bits ≥ 36)

// // HEATSHRINK output buffer (commented out)
// static uint8_t  zbuf[640];
// static uint16_t zpos;
// static uint8_t  zbit;

static uint16_t rng = 0xACE1;
static uint8_t  rnd() { rng = rng * 25173u + 13849u; return (uint8_t)(rng >> 5); }

// ═══════════════════════════════════════════════════════════════════
// HEATSHRINK encoder (preserved, commented out)
// ═══════════════════════════════════════════════════════════════════
/*
static void hse_reset() {
    zpos = 0; zbit = 0; zbuf[0] = 0;
}
static void hse_write_bit(uint8_t bit) {
    if (bit) zbuf[zpos] |= (1U << (7 - zbit));
    if (++zbit == 8) { zbit = 0; zpos++; zbuf[zpos] = 0; }
}
static void hse_write_bits(uint16_t val, uint8_t n) {
    while (n--) { hse_write_bit((val >> n) & 1); }
}
static void hse_flush() {
    if (zbit > 0) { zpos++; zbit = 0; }
}
static void hse_varint(uint8_t sz2, uint16_t val) {
    uint8_t chunks[4]; uint8_t n = 0;
    do { chunks[n++] = val & ((1U << sz2) - 1); val >>= sz2; } while (val > 0);
    while (n--) { hse_write_bit(n > 0); hse_write_bits(chunks[n], sz2); }
}
static uint16_t hse_encode(const uint8_t *input, uint16_t len) {
    hse_reset(); uint16_t pos = 0;
    while (pos < len) {
        uint8_t best_len = 0; uint16_t best_off = 0;
        uint16_t ws = (pos > HSE_WINDOW_SIZE) ? (uint16_t)(pos - HSE_WINDOW_SIZE) : 0;
        uint8_t ml = HSE_LOOKAHEAD_MAX;
        if ((uint16_t)(pos + ml) > len) ml = (uint8_t)(len - pos);
        for (uint16_t off = 1; off <= (uint16_t)(pos - ws) && best_len < ml; off++) {
            uint16_t i = pos - off; uint8_t l = 0;
            while (l < ml && input[i + l] == input[pos + l]) l++;
            if (l > best_len) { best_len = l; best_off = off; }
        }
        if (best_len >= HSE_MIN_MATCH) {
            hse_write_bit(1); hse_varint(HSE_LOOKAHEAD_SZ2, (uint16_t)(best_len - HSE_MIN_MATCH));
            hse_varint(HSE_WINDOW_SZ2, best_off); pos += best_len;
        } else {
            hse_write_bit(0); hse_write_bits(input[pos], 8); pos++;
        }
    }
    hse_flush(); return zpos;
}
*/

// ═══════════════════════════════════════════════════════════════════
// Tile helpers
// ═══════════════════════════════════════════════════════════════════

// XOR hash of a 4×4 tile (32 bytes → 1 byte)
static uint8_t tile_hash(uint8_t tx, uint8_t ty) {
    uint8_t h = 0;
    uint8_t *row = (uint8_t *)&img[(uint16_t)ty * TILE_PX * IMG_W + tx * TILE_PX];
    for (uint8_t r = 0; r < TILE_PX; r++) {
        for (uint8_t i = 0; i < TILE_PX * 2; i++) h ^= row[i];
        row += IMG_W * 2;
    }
    return h;
}

// Compare all tiles against previous frame, build changed_mask, return changed count
static uint8_t tile_detect_changes() {
    uint8_t count = 0;
    for (uint8_t i = 0; i < 8; i++) changed_mask[i] = 0;
    for (uint8_t ty = 0; ty < TILE_GRID; ty++) {
        for (uint8_t tx = 0; tx < TILE_GRID; tx++) {
            uint8_t h = tile_hash(tx, ty);
            uint8_t idx = ty * TILE_GRID + tx;
            if (h != prev_hash[idx]) {
                prev_hash[idx] = h;
                changed_mask[idx >> 3] |= (1 << (idx & 7));
                count++;
            }
        }
    }
    return count;
}

// ── Static grid background + 2 bouncing dots ────────────────────
// Background: dark blue canvas + white grid (4px spacing, matches tile grid).
// Grid is static → never triggers changed tiles. Only dots cause P-frame blocks.

static void render_background() {
    for (uint8_t y = 0; y < IMG_H; y++) {
        uint8_t on_h = (y % TILE_PX) == 0;  // horizontal grid line
        for (uint8_t x = 0; x < IMG_W; x++) {
            uint8_t on_v = (x % TILE_PX) == 0;  // vertical grid line
            if (on_h && on_v) {
                img[y * IMG_W + x] = 0xFFFF;     // intersection = white
            } else if (on_h || on_v) {
                img[y * IMG_W + x] = 0x4208;     // grid line = dim gray
            } else {
                img[y * IMG_W + x] = 0x0011;     // cell = dark navy
            }
        }
    }
}

// Bouncing dot state: 16.4 fixed-point position, int8 velocity (1/16 px per frame)
#define N_DOTS 2
static uint16_t dx[N_DOTS], dy[N_DOTS];  // 16.4 fixed-point
static int8_t   dvx[N_DOTS], dvy[N_DOTS];
static const uint16_t dot_color[N_DOTS] = { 0xF800, 0x07E0 };  // red, green

static void dots_init() {
    dx[0]  = 4 * 16;  dy[0]  = 6 * 16;  dvx[0] = 4;  dvy[0] = 5;
    dx[1]  = 16 * 16; dy[1]  = 14 * 16; dvx[1] = -3; dvy[1] = 4;
}

// Draw a 3×3 dot centered at fixed-point (px, py)
static void draw_dot(uint16_t px, uint16_t py, uint16_t color) {
    int16_t cx = (int16_t)(px >> 4);  // integer center
    int16_t cy = (int16_t)(py >> 4);
    for (int8_t dy = -1; dy <= 1; dy++) {
        for (int8_t dx = -1; dx <= 1; dx++) {
            int16_t x = cx + dx, y = cy + dy;
            if (x < 0 || x >= IMG_W || y < 0 || y >= IMG_H) continue;
            // Center pixel = full brightness, edge = 50%
            if (dx == 0 && dy == 0) {
                img[y * IMG_W + x] = color;
            } else {
                uint16_t prev = img[y * IMG_W + x];
                uint8_t r = (((prev >> 11) & 0x1F) + ((color >> 11) & 0x1F)) / 2;
                uint8_t g = (((prev >> 5) & 0x3F) + ((color >> 5) & 0x3F)) / 2;
                uint8_t b = ((prev & 0x1F) + (color & 0x1F)) / 2;
                img[y * IMG_W + x] = ((uint16_t)r << 11) | ((uint16_t)g << 5) | b;
            }
        }
    }
}

static void update_dots() {
    for (uint8_t i = 0; i < N_DOTS; i++) {
        dx[i] += (uint16_t)(int16_t)dvx[i];
        dy[i] += (uint16_t)(int16_t)dvy[i];
        int16_t cx = (int16_t)(dx[i] >> 4);
        int16_t cy = (int16_t)(dy[i] >> 4);
        if (cx < 1 || cx >= IMG_W - 1) dvx[i] = -dvx[i];
        if (cy < 1 || cy >= IMG_H - 1) dvy[i] = -dvy[i];
    }
}

static void render_frame(uint16_t frame_id) {
    (void)frame_id;  // background is static — frame_id unused
    render_background();
    update_dots();
    for (uint8_t i = 0; i < N_DOTS; i++) {
        draw_dot(dx[i], dy[i], dot_color[i]);
    }
}

static void burn_cycles(uint16_t n) {
    volatile uint16_t acc = rng;
    for (uint16_t i = 0; i < n; i++) acc = acc * 6967u + 1234u;
    rng ^= (uint8_t)acc;
}

// ── Free RAM ──────────────────────────────────────────────────────
static uint16_t free_ram() {
    extern int __heap_start, *__brkval;
    int v;
    return (uint16_t)((int)&v - (__brkval == 0 ? (int)&__heap_start : (int)__brkval));
}

// ── Serial send ───────────────────────────────────────────────────
static void send_log(const char *text) {
    int len = strlen(text);
    if (len > 256) len = 256;
    uint8_t hdr[3] = { 0xDD, (uint8_t)(len >> 8), (uint8_t)(len & 0xFF) };
    uint8_t cs = 0;
    for (int i = 0; i < 3; i++) cs += hdr[i];
    for (int i = 0; i < len; i++) cs += (uint8_t)text[i];
    Serial.write(hdr, 3);
    Serial.write((const uint8_t *)text, len);
    Serial.write(&cs, 1);
}

// Returns payload size in bytes
static uint16_t send_image_frame(uint16_t frame_id) {
    render_frame(frame_id);
    burn_cycles((uint16_t)rnd() * 8u);

    uint16_t raw_size = IMG_W * IMG_H * 2;  // 24*24*2 = 1152
    uint16_t payload_size;
    uint8_t  fmt;
    uint8_t  n_changed = 0;
    uint8_t  is_keyframe = (frame_id % KEYFRAME_INTERVAL) == 0;

    if (is_keyframe) {
        // ── I-frame: RAW ─────────────────────────────────────────
        payload_size = raw_size;
        fmt = 0x20;  // PixelFormat=RGB565(2), Codec=RAW(0)
        // Update all prev_hash so next P-frame diffs correctly
        for (uint8_t ty = 0; ty < TILE_GRID; ty++)
            for (uint8_t tx = 0; tx < TILE_GRID; tx++)
                prev_hash[ty * TILE_GRID + tx] = tile_hash(tx, ty);

    } else {
        // ── P-frame: Tile (call tile_detect_changes ONCE) ────────
        fmt = 0x23;  // PixelFormat=RGB565(2), Codec=Tile(3)
        n_changed = tile_detect_changes();
        payload_size = 2 + n_changed * (1 + TILE_BYTES);  // Sum+CutInfo + blocks
    }

    // Header: 0xCC + Length(2B) + Frame(2B) + Width(1B) + Height(1B) + Format(1B)
    uint16_t data_len = 5 + payload_size;
    uint8_t hdr[8] = { 0xCC,
        (uint8_t)(data_len >> 8), (uint8_t)(data_len & 0xFF),
        (uint8_t)(frame_id >> 8), (uint8_t)(frame_id & 0xFF),
        IMG_W, IMG_H, fmt };
    uint8_t cs = 0;
    for (int i = 0; i < 8; i++) cs += hdr[i];
    Serial.write(hdr, 8);

    if (is_keyframe) {
        // RAW payload
        uint8_t *p = (uint8_t *)img;
        for (uint16_t i = 0; i < raw_size; i++) cs += p[i];
        Serial.write(p, raw_size);

    } else {
        // Tile payload (reuse n_changed + changed_mask from above)
        uint8_t cut_info = (TILE_GRID << 4) | TILE_GRID;  // 0x66

        cs += n_changed;  Serial.write(&n_changed, 1);
        cs += cut_info;   Serial.write(&cut_info, 1);

        for (uint8_t idx = 0; idx < TILE_COUNT; idx++) {
            if (!(changed_mask[idx >> 3] & (1 << (idx & 7)))) continue;
            uint8_t tx = idx % TILE_GRID, ty = idx / TILE_GRID;
            cs += (uint8_t)idx;  Serial.write((uint8_t)idx);
            uint8_t *blk = (uint8_t *)&img[(uint16_t)ty * TILE_PX * IMG_W + tx * TILE_PX];
            for (uint8_t r = 0; r < TILE_PX; r++) {
                uint8_t *row = blk + r * IMG_W * 2;
                for (uint8_t i = 0; i < TILE_PX * 2; i++) cs += row[i];
                Serial.write(row, TILE_PX * 2);
            }
        }
    }

    Serial.write(&cs, 1);

    // // ── HEATSHRINK mode (Codec=2) — preserved ──────────────────
    // uint16_t zsize = hse_encode((uint8_t *)img, raw_size);
    // uint16_t data_len = 5 + zsize;
    // uint8_t  fmt = 0x22;
    // uint8_t hdr[8] = { 0xCC, ... };
    // ... send zbuf ...

    return payload_size;
}

// Resource frame: 0xEE + Length(2B) + Data(9B) + CS(1B)
static void send_resource(uint8_t cpu_pct, int16_t speed, int16_t servo) {
    uint16_t rom_free = ROM_TOTAL - sizeof(img) - sizeof(prev_hash) - sizeof(changed_mask) - sizeof(rng);
    uint16_t ram_free = free_ram();

    uint8_t buf[13];
    buf[0]  = 0xEE;
    buf[1]  = 0;
    buf[2]  = 9;
    buf[3]  = cpu_pct;
    buf[4]  = (uint8_t)(ram_free >> 8);   buf[5]  = (uint8_t)(ram_free & 0xFF);
    buf[6]  = (uint8_t)(rom_free >> 8);   buf[7]  = (uint8_t)(rom_free & 0xFF);
    buf[8]  = (uint8_t)(speed >> 8);      buf[9]  = (uint8_t)(speed & 0xFF);
    buf[10] = (uint8_t)(servo >> 8);      buf[11] = (uint8_t)(servo & 0xFF);
    uint8_t cs = 0;
    for (int i = 0; i < 12; i++) cs += buf[i];
    buf[12] = cs;
    Serial.write(buf, 13);
}

// ── Setup / Loop ──────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    dots_init();
    // Init prev_hash to 0xFF so first frame always sends all blocks
    for (uint8_t i = 0; i < TILE_COUNT; i++) prev_hash[i] = 0xFF;
    delay(3000);
    send_log("[BOOT] RGB565 Tile 24x24 2-dot bounce (keyframe/16)\r\n");
}

static uint16_t frame = 0;
static uint16_t last_psize = 0;

void loop() {
    int16_t speed = (int16_t)((frame % 1000) - 500);
    int16_t servo = (int16_t)((frame % 600) - 300);

    unsigned long t0 = micros();
    last_psize = send_image_frame(frame++);
    Serial.flush();
    unsigned long elapsed = micros() - t0;
    uint8_t cpu_pct = (uint8_t)min(100UL, elapsed * 100UL / 40000UL);
    send_resource(cpu_pct, speed, servo);

    if (frame % 10 == 0) {
        char buf[64];
        snprintf(buf, sizeof(buf), "[DBG] frame=%u cpu=%u%% p=%u\r\n",
                 frame, cpu_pct, last_psize);
        send_log(buf);
    }
}
