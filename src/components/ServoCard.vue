<template>
  <div class="mini-head">
    <span>Servo attitude</span><b>{{ deg }}°</b>
  </div>
  <div class="attitude">
    <div class="sky" :style="{ transform: `rotate(${visualDeg}deg)` }">
      <i />
    </div>
    <div class="aircraft">⌃</div>
    <div class="ticks">
      <span>-45</span><span>0</span><span>45</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ deg: string; visualDeg: number }>();
</script>

<style scoped>
.mini-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 900;
}
.mini-head b { color: var(--text); font-size: 15px; }
.attitude {
  position: relative;
  height: calc(100% - 30px);
  margin-top: 10px;
  border-radius: 16px;
  overflow: hidden;
  background: #edf1ec;
}
.sky {
  position: absolute;
  inset: -32%;
  background: linear-gradient(#88c7ef 0 49%, #fff 49% 51%, #d9b06a 51%);
  transition: transform 0.45s ease;
}
.sky i {
  position: absolute;
  left: 50%; top: 50%;
  width: 160%; height: 1px;
  background: rgba(255,255,255,0.9);
  transform: translate(-50%, -50%);
}
.aircraft {
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  font-size: 38px;
  font-weight: 900;
  color: #242424;
  text-shadow: 0 1px 0 #fff;
}
.ticks {
  position: absolute;
  left: 12px; right: 12px; bottom: 8px;
  display: flex;
  justify-content: space-between;
  color: rgba(36,36,36,0.54);
  font-size: 10px;
  font-weight: 900;
}
</style>
