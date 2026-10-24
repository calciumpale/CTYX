import type { StoredVector } from './talktrack-types.ts';

const invalidVector = () => new Error('Embedding 返回的向量无效，请检查模型及向量维度后重试');

/** Validates an entire batch before any candidate can enter the review queue. */
export function validateVectors(value:unknown, expectedCount?:number):number[][] {
  if(!Array.isArray(value)||!value.length||value.length>1000)throw invalidVector();
  if(expectedCount!==undefined&&(!Number.isSafeInteger(expectedCount)||expectedCount!==value.length))throw invalidVector();
  let dimensions=0;
  return value.map(item=>{
    if(!Array.isArray(item)||!item.length||item.length>8192)throw invalidVector();
    if(!dimensions)dimensions=item.length;
    if(item.length!==dimensions||item.some(number=>typeof number!=='number'||!Number.isFinite(number))||!item.some(number=>number!==0))throw invalidVector();
    return [...item] as number[];
  });
}

export function cosineSimilarity(left:number[],right:number[]):number {
  const [a,b]=validateVectors([left,right]);
  // Scale before normalizing so valid very large or very small floats stay finite.
  const aScale=Math.max(...a.map(Math.abs));const bScale=Math.max(...b.map(Math.abs));
  const scaledA=a.map(value=>value/aScale);const scaledB=b.map(value=>value/bScale);
  const aNorm=Math.hypot(...scaledA);const bNorm=Math.hypot(...scaledB);
  const score=scaledA.reduce((sum,value,index)=>sum+(value/aNorm)*(scaledB[index]/bNorm),0);
  return Math.max(-1,Math.min(1,score));
}

/** Exact cosine comparison, including earlier accepted candidates in this batch. */
export function deduplicate<T extends {title:string;vector:number[];model:string}>(candidates:T[],existing:StoredVector[],threshold=0.90):{accepted:T[];duplicates:{title:string;score:number}[]} {
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('向量相似度阈值须为0至1');
  const accepted:T[]=[];const duplicates:{title:string;score:number}[]=[];
  const compared=existing.map(entry=>({...entry,vector:[...entry.vector]}));
  for(const candidate of candidates) {
    validateVectors([candidate.vector]);
    if(typeof candidate.model!=='string'||!candidate.model.trim())throw new Error('Embedding 模型标识缺失');
    let nearest:{title:string;score:number}|undefined;
    for(const entry of compared) {
      if(entry.model!==candidate.model)continue;
      if(entry.vector.length!==candidate.vector.length)throw new Error('同一 Embedding 模型的索引维度不一致，请重建该模型的向量索引');
      const score=cosineSimilarity(candidate.vector,entry.vector);
      if(!nearest||score>nearest.score)nearest={title:entry.title,score};
    }
    if(nearest&&nearest.score>=threshold)duplicates.push(nearest);
    else {
      accepted.push(candidate);
      compared.push({id:`batch-${accepted.length}`,title:candidate.title,vector:[...candidate.vector],model:candidate.model});
    }
  }
  return {accepted,duplicates};
}
