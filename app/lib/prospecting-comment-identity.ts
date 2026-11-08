import type { ProspectComment } from './prospecting-types.ts';

type IdentityInput = Pick<ProspectComment, 'id' | 'videoId' | 'text' | 'nickname' | 'recipientId' | 'profileUrl' | 'postedAt' | 'source'>;

function clean(value: string | undefined): string { return value?.trim() ?? ''; }

export function prospectCommentIdentity(comment: IdentityInput): string {
  const id = clean(comment.id);
  if (!id.startsWith('dom:')) return JSON.stringify(['native', id]);
  const recipientId = clean(comment.recipientId);
  // profileUrl is only identity evidence when paired with an already-normalized recipientId.
  const author = recipientId ? ['recipient', recipientId] : ['nickname', clean(comment.nickname)];
  return JSON.stringify(['fallback', clean(comment.videoId), author, clean(comment.text)]);
}

export function prospectCommentAliases(comment: IdentityInput): string[] {
  const identity = prospectCommentIdentity(comment);
  const rawId = clean(comment.id);
  return rawId && rawId !== identity ? [identity, rawId] : [identity];
}
