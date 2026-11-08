import test from 'node:test';
import assert from 'node:assert/strict';
import { prospectCommentAliases, prospectCommentIdentity } from '../app/lib/prospecting-comment-identity.ts';
import type { ProspectComment } from '../app/lib/prospecting-types.ts';

const comment=(patch:Partial<ProspectComment>={}):ProspectComment=>({id:'dom:old1',videoId:'v1',videoUrl:'',text:'hello',nickname:'Alice',source:'browser',...patch});
test('native ids preserve distinct comments by the same author',()=>assert.notEqual(prospectCommentIdentity(comment({id:'native:1'})),prospectCommentIdentity(comment({id:'native:2'}))));
test('fallback ignores changing relative time and old DOM hashes',()=>{
 const a=comment({id:'dom:one',postedAt:'2 hours ago',recipientId:'42'}),b=comment({id:'dom:two',postedAt:'3 hours ago',recipientId:'42'});
 assert.equal(prospectCommentIdentity(a),prospectCommentIdentity(b)); assert.deepEqual(prospectCommentAliases(a),[prospectCommentIdentity(a),'dom:one']);
});
test('fallback separates video, author and text; trims anonymous nickname',()=>{
 const base=comment({id:'dom:a'});
 assert.notEqual(prospectCommentIdentity(base),prospectCommentIdentity(comment({id:'dom:b',videoId:'v2'})));
 assert.notEqual(prospectCommentIdentity(base),prospectCommentIdentity(comment({id:'dom:b',nickname:'Bob'})));
 assert.equal(prospectCommentIdentity(base),prospectCommentIdentity(comment({id:'dom:b',nickname:' Alice '})));
 assert.notEqual(prospectCommentIdentity(base),prospectCommentIdentity(comment({id:'dom:b',text:'other'})));
});
