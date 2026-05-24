export { getStateSummary } from './getStateSummary';
export { getCategoryAggregate } from './getCategoryAggregate';
export { getBvsSnapshot } from './getBvsSnapshot';
export { attachToEvaluate } from './attachToEvaluate';
export { assertNoRawText, RawTextLeakError } from './privacy';
export type {
  BehaviorCategory,
  BvsSnapshot,
  ConsentClassProjection,
  StateSummary,
  CategoryAggregate,
  BehaviorClientOptions,
  GetStateSummaryOptions,
  GetCategoryAggregateOptions,
} from './types';
