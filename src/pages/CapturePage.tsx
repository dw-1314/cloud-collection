import { useState } from 'react';
import { getArtwork } from '../data/artworks';
import { SplatViewer } from '../viewer/SplatViewer';
export default function CapturePage({id}:{id:string}){const art=getArtwork(id);const [visible,setVisible]=useState(true);return art?<div className="capture-page">{visible&&<SplatViewer model={art}/>}<button onClick={()=>setVisible(!visible)}>卸载模型</button></div>:null;}
