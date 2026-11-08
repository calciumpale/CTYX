/** Public account-scoped digital-human records. Secrets and object keys are never projected. */
export type DigitalHumanSourceKind = 'photo' | 'video' | 'existing';
export type DigitalHumanAssetStatus = 'uploading' | 'upload_failed' | 'awaiting_customization' | 'ready';
export interface DigitalHumanAsset {
  id: string;
  requestId: string;
  version: number;
  name: string;
  sourceKind: DigitalHumanSourceKind;
  status: DigitalHumanAssetStatus;
  fileName?: string;
  mime?: string;
  size?: number;
  sourceUrl?: string;
  digitalHumanId?: string;
  digitalHumanName?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export type DigitalHumanLiveStatus = 'draft' | 'starting' | 'start_unknown' | 'running' | 'stopping' | 'stop_unknown' | 'stopped' | 'error';
export type DigitalHumanProviderState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';
export interface DigitalHumanCommand {
  requestId: string;
  status: 'sending' | 'accepted' | 'unknown' | 'failed';
  text: string;
  createdAt: string;
}
export interface DigitalHumanLive {
  id: string;
  requestId: string;
  version: number;
  assetId: string;
  name: string;
  platform: string;
  hasPushUrl: boolean;
  pushUrlDisplay: string;
  status: DigitalHumanLiveStatus;
  providerState?: DigitalHumanProviderState;
  hasInstance: boolean;
  /** Local start intent identifying this live generation; never a provider instance ID. */
  generationId?: string;
  lastCommand?: DigitalHumanCommand;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface DigitalHumanAvailability {
  configured: boolean;
  enabled: boolean;
  storageReady: boolean;
  liveReady: boolean;
  customizationMode: 'zego_platform';
}
export interface ZegoConnection extends DigitalHumanAvailability {
  appId: string;
  agentId: string;
  hasSecret: boolean;
  version: number;
  avatarGrants: Array<{digitalHumanId: string; memberId: string}>;
}
export interface DigitalHumanSnapshot {
  assets: DigitalHumanAsset[];
  lives: DigitalHumanLive[];
  connection: DigitalHumanAvailability;
}
export interface DigitalHumanEnvironment {
  DB?: D1Database;
  BUCKET?: R2Bucket;
  CONFIG_ENCRYPTION_KEY?: string;
}
export interface StoredDigitalHumanAsset extends Omit<DigitalHumanAsset, 'sourceUrl'> {
  ownerId: string;
  memberId: string;
  payloadHash: string;
  fileKey?: string;
  sourceHash?: string;
  uploadToken?: string;
  uploadUntil?: number;
  verifiedAppId?: string;
}
export interface StoredDigitalHumanLive extends Omit<DigitalHumanLive, 'hasPushUrl' | 'hasInstance'> {
  ownerId: string;
  memberId: string;
  payloadHash: string;
  configHash?: string;
  pushCiphertext: string;
  providerInstanceId?: string;
  providerAppId?: string;
  credentialCiphertext?: string;
  activeOperation?: string;
  generationRequestId?: string;
  pollAt?: number;
}
export type DigitalHumanOperation = 'startLive' | 'stopLive' | 'speak';
export interface StoredDigitalHumanOperation {
  ownerId: string;
  memberId: string;
  liveId: string;
  requestId: string;
  action: DigitalHumanOperation;
  generationId?: string;
  payloadHash: string;
  status: 'sending' | 'accepted' | 'unknown' | 'failed';
  text?: string;
  providerInstanceId?: string;
  credentialCiphertext?: string;
  error?: string;
  compensated?: boolean;
  createdAt: string;
}
