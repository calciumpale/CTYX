/** Retains identities for immutable intents, including ambiguous accepted responses. */
export function createKnowledgeRequestIdentity(makeId: () => string = () => crypto.randomUUID()) {
  const identities = new Map<string, string>();
  const get = (intent: unknown) => {
    const key = JSON.stringify(intent);
    let id = identities.get(key);
    if (!id) { id = makeId(); identities.set(key, id); }
    return id;
  };
  get.retire = (intent: unknown) => { identities.delete(JSON.stringify(intent)); };
  get.retireDocument = (documentId: string) => { for (const key of identities.keys()) { const intent = JSON.parse(key); if (intent?.action === 'beginRechunk' && intent.documentId === documentId) identities.delete(key); } };
  return get;
}
