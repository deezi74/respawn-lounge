import { randomUUID } from 'node:crypto';
import { storagePut, storageGetSignedUrl } from './storage';
const expected=`Respawn durable storage health check ${randomUUID()}`;
const stored=await storagePut(`diagnostics/${randomUUID()}.txt`,Buffer.from(expected),'text/plain');
const url=await storageGetSignedUrl(stored.key);
const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error(`Storage retrieval HTTP ${response.status}`);
if(await response.text()!==expected)throw new Error('Durable storage round-trip content mismatch');
console.log('PASS: actual durable upload and signed retrieval returned matching bytes. No user or app records created.');
