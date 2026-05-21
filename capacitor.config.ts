import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tracevector.pchost',
  appName: 'Trace Vector PC Host',
  webDir: 'dist',
  server: { androidScheme: 'https' },
};

export default config;
