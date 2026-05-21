import { ref, onMounted } from 'vue';

const platform = ref<'web' | 'tauri' | 'android'>('web');

export function usePlatform() {
  onMounted(() => {
    if ((window as any).__TAURI_INTERNALS__) { platform.value = 'tauri'; return; }
    if ((window as any).Capacitor?.isNativePlatform?.()) { platform.value = 'android'; }
  });
  return { platform };
}
