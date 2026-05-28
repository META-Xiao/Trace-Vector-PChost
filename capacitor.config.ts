import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.theia.monitor',
  appName: 'Theia Monitor',
  webDir: 'dist',
  server: { androidScheme: 'https' },
};

export default config;
