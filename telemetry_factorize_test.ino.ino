// Image telemetry protocol debug test
// Target: Arduino Leonardo (ATmega32U4)

#include <Arduino.h>

#define IMG_W 32
#define IMG_H 32

static uint8_t img[IMG_W * IMG_H];

#define N_STARS 32
// position in fixed-point: actual = val/16, range 0..31*16=496
static uint16_t sx[N_STARS], sy[N_STARS];
// velocity in fixed-point units per frame
static int8_t   svx[N_STARS], svy[N_STARS];

// simple LCG for deterministic pseudo-random
static uint16_t rng = 0xACE1;
static uint8_t rnd() { rng = rng * 25173u + 13849u; return (uint8_t)(rng >> 5); }

static void star_reset(uint8_t i) {
    sx[i]  = 16 * 16; // center x = 16.0
    sy[i]  = 16 * 16; // center y = 16.0
    // velocity: -8..+8 fixed-point, avoid zero
    int8_t dx = (int8_t)(rnd() % 17) - 8; if (dx == 0) dx = 1;
    int8_t dy = (int8_t)(rnd() % 17) - 8; if (dy == 0) dy = 1;
    svx[i] = dx;
    svy[i] = dy;
}

static void stars_init() {
    for (uint8_t i = 0; i < N_STARS; i++) {
        star_reset(i);
        // scatter initial positions so they don't all start at center
        sx[i] += (int16_t)(rnd() % 64) - 32;
        sy[i] += (int16_t)(rnd() % 64) - 32;
    }
}

static void render_frame(uint16_t n) {
    (void)n;
    // slow fade
    for (int i = 0; i < IMG_W * IMG_H; i++)
        img[i] = (img[i] * 200u) >> 8; // *~0.78

    for (uint8_t i = 0; i < N_STARS; i++) {
        sx[i] += svx[i];
        sy[i] += svy[i];
        int16_t px = sx[i] >> 4, py = sy[i] >> 4;
        if (px < 0 || px >= IMG_W || py < 0 || py >= IMG_H) {
            star_reset(i);
            continue;
        }
        // brightness grows with distance from center (depth cue)
        int16_t ddx = px - 16, ddy = py - 16;
        uint8_t dist = (uint8_t)((ddx < 0 ? -ddx : ddx) + (ddy < 0 ? -ddy : ddy));
        uint8_t bright = dist * 16; // 0..240
        uint8_t *p = &img[py * IMG_W + px];
        if (bright > *p) *p = bright;
    }
}

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

static void send_image_frame(uint16_t frame_id) {
    render_frame(frame_id);
    uint8_t hdr[7] = { 0xCC, (uint8_t)(frame_id >> 8), (uint8_t)(frame_id & 0xFF), 100, 25, IMG_W, IMG_H };
    uint8_t cs = 0;
    for (int i = 0; i < 7; i++) cs += hdr[i];
    Serial.write(hdr, 7);
    for (int i = 0; i < IMG_W * IMG_H; i++) cs += img[i];
    Serial.write(img, IMG_W * IMG_H);
    Serial.write(&cs, 1);
}

static void send_resource(uint8_t cpu_pct, int16_t speed, int16_t servo) {
    uint8_t buf[18];
    buf[0]  = 0xEE;
    buf[1]  = cpu_pct;
    buf[2]  = 40;
    buf[3]  = 0x1F; buf[4]  = 0x40;
    buf[5]  = 0x0D; buf[6]  = 0xA0;
    buf[7]  = 0x60; buf[8]  = 0x00;
    buf[9]  = (uint8_t)(speed >> 8);   buf[10] = (uint8_t)(speed & 0xFF);
    buf[11] = (uint8_t)(servo >> 8);   buf[12] = (uint8_t)(servo & 0xFF);
    memset(buf + 13, 0, 4);
    uint8_t cs = 0;
    for (int i = 0; i < 17; i++) cs += buf[i];
    buf[17] = cs;
    Serial.write(buf, 18);
}

void setup() {
    Serial.begin(115200);
    stars_init();
    delay(3000);
    send_log("[BOOT] image telemetry test started\r\n");
}

static uint16_t frame = 0;

void loop() {
    int16_t speed = (int16_t)(frame % 1000) - 500;
    int16_t servo = (int16_t)(frame % 600) - 300;

    unsigned long t0 = micros();
    send_image_frame(frame++);
    Serial.flush();
    unsigned long elapsed = micros() - t0;
    uint8_t cpu_pct = (uint8_t)min(100UL, elapsed * 100UL / 2000000UL);
    send_resource(cpu_pct, speed, servo);

    if (frame % 10 == 0) {
        char buf[64];
        snprintf(buf, sizeof(buf), "[DBG] frame=%u cpu=%u%%\r\n", frame, cpu_pct);
        send_log(buf);
    }
}
