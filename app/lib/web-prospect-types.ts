export type WebPlatform = 'all' | 'tieba' | 'xiaohongshu' | 'zhihu' | 'weibo' | 'other';
export interface WebSearchInput {
    keywords: string[];
    region: string;
    platform: WebPlatform;
}
export interface WebProspectSource {
    sourceUrl: string;
    title: string;
    excerpt: string;
    platform: WebPlatform;
    query: string;
    region: string;
    regionMatch: 'confirmed' | 'unverified';
    regionEvidence: string;
    retrievedAt: string;
    publishedAt?: string;
}
export interface WebProspectTask extends WebSearchInput {
    id: string;
    ownerId: string;
    memberId: string;
    requestId: string;
    payloadHash: string;
    status: 'running' | 'completed' | 'partial' | 'failed';
    errors: string[];
    createdAt: string;
    updatedAt: string;
    resultCount: number;
}
export interface WebProspectLead extends WebProspectSource {
    id: string;
    taskId: string;
    ownerId: string;
    memberId: string;
    version: number;
    status: 'new' | 'qualified' | 'ignored';
    projectId?: string;
}
export interface WebProspectSnapshot {
    tasks: WebProspectTask[];
    leads: WebProspectLead[];
    owners?: {
        salesId: string;
        displayName: string;
    }[];
}
