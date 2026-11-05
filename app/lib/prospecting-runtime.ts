import {env} from 'cloudflare:workers';
import {DomainError} from './domain.ts';
import {readEffectiveModel} from './connection-store.ts';
import {createProspectingService} from './prospecting-service.ts';
export function prospectingService(){const db=(env as Cloudflare.Env).DB;if(!db)throw new DomainError('获客数据库尚未连接',503);return createProspectingService({db,readModel:readEffectiveModel});}
