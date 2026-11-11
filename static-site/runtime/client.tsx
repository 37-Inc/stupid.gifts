import {hydrateRoot} from 'react-dom/client';
import {RuntimeApp} from './App.tsx';
import type {RuntimePageProps} from './App.tsx';
const root=document.getElementById('runtime-app'),data=document.getElementById('runtime-props');
if(root&&data)hydrateRoot(root,<RuntimeApp {...JSON.parse(data.textContent??'{}') as RuntimePageProps}/>);
