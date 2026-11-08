import { sha256, validateNetworkId } from './types.js';
import type { WorkItem } from './work-items.js';

export interface WorkBudgetLimits { maxReviewRounds:number; maxRepeatedFindings:number; maxElapsedSeconds:number; }
export interface WorkEscalation { id:string;reason:string;question:string;createdAt:string;notifiedAt?:string; }
export interface WorkBudget {
  limits:WorkBudgetLimits;deadline:string;reviewRounds:number;repeatedFindings:Record<string,number>;escalation?:WorkEscalation;
}
export const DEFAULT_WORK_BUDGET:WorkBudgetLimits={maxReviewRounds:5,maxRepeatedFindings:3,maxElapsedSeconds:86400};
export function parseWorkBudget(value:unknown):WorkBudget {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid recorded work budget');
  const budget=value as WorkBudget;
  const keys=Object.keys(budget).filter(key=>key!=='escalation').sort().join(',');
  if(keys!=='deadline,limits,repeatedFindings,reviewRounds' || typeof budget.deadline!=='string' || !Number.isFinite(Date.parse(budget.deadline))
    || !Number.isSafeInteger(budget.reviewRounds) || budget.reviewRounds<0 || budget.reviewRounds>1024
    || !budget.repeatedFindings || typeof budget.repeatedFindings!=='object' || Array.isArray(budget.repeatedFindings)
    || Object.keys(budget.repeatedFindings).length>1024)throw new Error('Invalid recorded work budget');
  parseWorkBudgetLimits(budget.limits,true);
  for(const [id,count] of Object.entries(budget.repeatedFindings)) {
    validateNetworkId(id,'budget finding');if(!Number.isSafeInteger(count) || count<0 || count>1024)throw new Error('Invalid recorded finding count');
  }
  if(budget.escalation!==undefined) {
    const e=budget.escalation;
    if(!e || typeof e!=='object' || Object.keys(e).filter(key=>key!=='notifiedAt').sort().join(',')!=='createdAt,id,question,reason'
      || typeof e.id!=='string' || !/^sha256:[a-f0-9]{64}$/.test(e.id)
      || typeof e.reason!=='string' || !e.reason || e.reason.length>4096 || typeof e.question!=='string' || !e.question || e.question.length>8192
      || typeof e.createdAt!=='string' || !Number.isFinite(Date.parse(e.createdAt)) || e.notifiedAt!==undefined && !Number.isFinite(Date.parse(e.notifiedAt)))throw new Error('Invalid recorded escalation');
  }
  return budget;
}
export function parseWorkBudgetLimits(value:unknown,ownerOverride=false):WorkBudgetLimits {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid work budget');
  const v=value as WorkBudgetLimits;
  if(Object.keys(v).sort().join(',')!=='maxElapsedSeconds,maxRepeatedFindings,maxReviewRounds'
    || !Number.isInteger(v.maxReviewRounds) || v.maxReviewRounds<1 || v.maxReviewRounds>(ownerOverride?100:DEFAULT_WORK_BUDGET.maxReviewRounds)
    || !Number.isInteger(v.maxRepeatedFindings) || v.maxRepeatedFindings<1 || v.maxRepeatedFindings>(ownerOverride?100:DEFAULT_WORK_BUDGET.maxRepeatedFindings)
    || !Number.isInteger(v.maxElapsedSeconds) || v.maxElapsedSeconds<60 || v.maxElapsedSeconds>(ownerOverride?30*86400:DEFAULT_WORK_BUDGET.maxElapsedSeconds))throw new Error('Work budget exceeds local defaults; only an explicit local owner budget authorization can extend it');
  return {...v};
}
export function initialWorkBudget(createdAt:string,limits=DEFAULT_WORK_BUDGET):WorkBudget {
  return {limits:{...limits},deadline:new Date(Date.parse(createdAt)+limits.maxElapsedSeconds*1000).toISOString(),reviewRounds:0,repeatedFindings:{}};
}
function escalate(item:WorkItem,reason:string,now:number):void {
  const b=item.budget!;
  if(b.escalation)return;
  b.escalation={id:sha256(`${item.id}\0${item.version}\0${reason}`),reason,question:`${item.title}: ${reason}. Continue with an explicitly larger budget, or stop and choose a resolution?`,createdAt:new Date(now).toISOString()};
}
export function budgetBlocked(item:WorkItem,type:string,now=Date.now()):boolean {
  item.budget??=initialWorkBudget(item.createdAt,item.limits);
  if(!['claim','resume','revise','contribute','conclude'].includes(type))return false;
  if(now>=Date.parse(item.budget.deadline))escalate(item,'the collaboration time budget has expired',now);
  return !!item.budget.escalation;
}
export function recordReviewBudget(item:WorkItem,accepted:boolean,findings:Array<{id:string;status:string}>,now=Date.now()):void {
  item.budget??=initialWorkBudget(item.createdAt,item.limits);
  if(accepted){delete item.budget.escalation;return;}
  const budget=item.budget;budget.reviewRounds++;
  for(const finding of findings)if(finding.status==='open')Object.defineProperty(budget.repeatedFindings,finding.id,{value:(Object.hasOwn(budget.repeatedFindings,finding.id)?budget.repeatedFindings[finding.id]!:0)+1,writable:true,configurable:true,enumerable:true});
  const repeated=Object.entries(budget.repeatedFindings).find(([,count])=>count>=budget.limits.maxRepeatedFindings);
  if(repeated)escalate(item,`finding ${repeated[0]} remains unresolved after ${repeated[1]} review rounds`,now);
  else if(budget.reviewRounds>=budget.limits.maxReviewRounds)escalate(item,`the ${budget.limits.maxReviewRounds}-round review budget is exhausted`,now);
}
