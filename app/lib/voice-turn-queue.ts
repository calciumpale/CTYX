export type VoiceTurn={id:string;sessionId:string;text:string};
export type VoiceQueueSnapshot={pending:number;failed:VoiceTurn|null;error:string};

/** A final transcript is immutable. Saving failures retain the exact text for a one-click retry. */
export function createVoiceTurnQueue(save:(turn:VoiceTurn)=>Promise<void>,onChange:(snapshot:VoiceQueueSnapshot)=>void=()=>{}) {
  let generation=0;let running=false;let error='';let queue:VoiceTurn[]=[];
  const seen=new Set<string>();
  const snapshot=():VoiceQueueSnapshot=>({pending:queue.length,failed:error?queue[0]??null:null,error});
  const notify=()=>onChange(snapshot());
  const drain=async()=>{
    if(running||error||!queue.length)return;
    running=true;const owner=generation;
    try {
      while(queue.length&&owner===generation){
        try{await save(queue[0]);}catch(cause){if(owner===generation)error=cause instanceof Error?cause.message:'语音回应未保存，请重试';break;}
        if(owner!==generation)break;
        queue.shift();notify();
      }
    }finally{running=false;if(owner===generation)notify();else void drain();}
  };
  return {
    getSnapshot:snapshot,
    enqueue(turn:VoiceTurn){
      if(!turn.text.trim()||seen.has(turn.id))return;
      if(turn.text.length>4000)throw new Error('这一段语音超过4,000字，请分段表达');
      if(queue.length>=12)throw new Error('待保存的语音过多，请等待本轮保存后继续');
      seen.add(turn.id);queue.push({...turn,text:turn.text.trim()});notify();void drain();
    },
    retry(){error='';notify();void drain();},
    reset(){generation++;queue=[];error='';seen.clear();notify();},
  };
}
