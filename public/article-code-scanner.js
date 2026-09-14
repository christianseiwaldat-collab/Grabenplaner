(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GrabenplanerArticleScanner=api;
}(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  function searchValue(raw){
    if(typeof raw!=='string'||raw.length>2048)return null;
    let value=raw.trim();
    if(/^https?:\/\//i.test(value)){
      try{
        const url=new URL(value);if(url.username||url.password)return null;
        value=['ean','gtin','articleNumber','artikelnummer'].map(key=>url.searchParams.get(key)).find(Boolean)
          ||url.pathname.match(/(?:^|\/)01\/(\d{8,14})(?:\/|$)/)?.[1]||'';
      }catch{return null;}
    }
    // A QR link is never opened and credentials/payment/Wi-Fi payloads are not
    // sent to the search endpoint. Leading zeroes in article/EAN codes survive.
    return value&&value.length<=160&&!/[\u0000-\u001f\u007f<>]/.test(value)&&!/^[a-z][a-z0-9+.-]*:/i.test(value)?value:null;
  }
  let decoderPromise;
  const isEmptyFrame=error=>['NotFoundException','ChecksumException','FormatException'].includes(error?.getKind?.()||error?.name);
  function loadDecoder(environment){
    if(environment.ZXingBrowser)return Promise.resolve(environment.ZXingBrowser);
    if(!decoderPromise)decoderPromise=new Promise((resolve,reject)=>{
      const script=environment.document.createElement('script');script.src='/vendor/zxing-browser-v0.2.1/zxing-browser.min.js';script.async=true;
      script.onload=()=>environment.ZXingBrowser?resolve(environment.ZXingBrowser):reject(new Error('DECODER_UNAVAILABLE'));
      script.onerror=()=>{script.remove();reject(new Error('DECODER_UNAVAILABLE'));};environment.document.head.append(script);
    }).catch(error=>{decoderPromise=null;throw error;});
    return decoderPromise;
  }
  function create({dialog,video,status,onValue,active=()=>true,environment=globalThis,decoder=()=>loadDecoder(environment)}){
    let generation=0,stream=null,controls=null,destroyed=false;
    const stopTracks=value=>value?.getTracks().forEach(track=>track.stop());
    function stop(){generation++;try{controls?.stop();}finally{controls=null;stopTracks(stream);stream=null;video.pause?.();video.srcObject=null;}}
    function close(){stop();if(dialog.open)dialog.close();}
    const valid=ticket=>!destroyed&&ticket===generation&&dialog.open&&active();
    async function open(){
      if(destroyed||!active())return;
      close();const ticket=++generation;dialog.showModal();status.textContent='Kamera wird geöffnet …';
      try{
        if(!environment.navigator?.mediaDevices?.getUserMedia)throw new Error('CAMERA_UNAVAILABLE');
        const lib=await decoder();if(!valid(ticket))return;
        const acquired=await environment.navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
        if(!valid(ticket)){stopTracks(acquired);return;}stream=acquired;
        const reader=new lib.BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:160,delayBetweenScanSuccess:500});
        status.textContent='EAN oder QR-Code ruhig in die Kamera halten.';
        const scan=await reader.decodeFromStream(stream,video,(result,error,control)=>{
          if(!valid(ticket)){control?.stop();return;}
          if(!result){if(error&&!isEmptyFrame(error)){stop();status.textContent='Der Code konnte nicht gelesen werden. Bitte Kamera schließen und erneut versuchen.';}return;}
          const value=searchValue(result.getText());
          if(!value){status.textContent='Dieser QR-Code enthält keine verwendbare Artikelkennung. Bitte den EAN oder einen Artikelcode scannen.';return;}
          control?.stop();close();onValue(value);
        });
        if(!valid(ticket)){scan.stop();return;}controls=scan;
      }catch(error){
        if(!valid(ticket))return;stop();
        status.textContent=error.name==='NotAllowedError'?'Kamerazugriff wurde nicht erlaubt. Bitte die Kamera für den GP in den Browser-Einstellungen freigeben oder den Code eintippen.'
          :error.name==='NotFoundError'?'Keine Kamera gefunden. Der Code kann weiterhin eingetippt werden.'
          :error.name==='NotReadableError'?'Die Kamera wird möglicherweise bereits verwendet. Bitte die andere Kamera-Anwendung schließen und erneut versuchen.'
          :'Die Kamera ist derzeit nicht verfügbar. Bitte schließen und erneut versuchen oder den Code eintippen.';
      }
    }
    const visibility=()=>{if(environment.document?.hidden)close();};
    dialog.addEventListener('close',stop);dialog.addEventListener('cancel',close);
    environment.document?.addEventListener('visibilitychange',visibility);environment.addEventListener?.('pagehide',close);
    return {open,close,destroy(){destroyed=true;close();dialog.removeEventListener?.('close',stop);dialog.removeEventListener?.('cancel',close);environment.document?.removeEventListener('visibilitychange',visibility);environment.removeEventListener?.('pagehide',close);}};
  }
  return {searchValue,isEmptyFrame,create};
}));
