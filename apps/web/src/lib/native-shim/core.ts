// Web shim for @capacitor/core. The web client is NOT a Capacitor app
// (mobile records, web reads). Only the surface the ported code touches on the
// web path is implemented; native-only calls throw. TODO(web A8): remove the
// remaining native branches in App.tsx and delete these shims.
export const Capacitor = {
  getPlatform: (): 'web' | 'ios' | 'android' => 'web',
  isNativePlatform: (): boolean => false,
  convertFileSrc: (url: string): string => url,
};

export const CapacitorHttp = {
  // Native used this to bypass CORS; the web path (getPlatform() === 'web') uses
  // fetch() and never reaches here.
  request: async (_options?: unknown): Promise<never> => {
    throw new Error('CapacitorHttp is native-only; the web client uses fetch().');
  },
};
