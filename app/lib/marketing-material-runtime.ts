import {env} from 'cloudflare:workers';
import {createMaterialStore} from './marketing-material-store.ts';
import type {MaterialEnvironment} from './marketing-material-store.ts';
import {createMaterialService} from './marketing-material-service.ts';
import {readEffectiveModel} from './connection-store.ts';
export function materialRuntime(origin:string) {const environment=env as MaterialEnvironment;const store=createMaterialStore(environment);return {store,bucket:environment.BUCKET,service:createMaterialService({store,bucket:environment.BUCKET,model:owner=>readEffectiveModel(owner,origin)})};}
