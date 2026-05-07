export type ControlMode = "full" | "view";

export type ClientIdentity = {
  clientId: string;
  sessionPassword: string;
  passwordExpiresAt: string;
};

export type IncomingKnockPayload = {
  peerEndpoint?: string | null;
  peerIsLoopback?: boolean | null;
};

export type PreferencesShape = {
  setupComplete?: boolean;
  trustLoopbackLab?: boolean;
  loopbackAutoFullControl?: boolean;
  allowViewerPrivacyBlackout?: boolean;
};

export type ConsentCaps = {
  allowViewerPrivacyBlackout: boolean;
};

export type TransmitPulse = {
  mouse: boolean;
  keyboard: boolean;
};

export type HostInputNotifyPayload = {
  kind: "mouse" | "click" | "key";
  label: string;
};
