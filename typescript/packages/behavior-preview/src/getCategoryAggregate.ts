import type {
  BehaviorCategory,
  CategoryAggregate,
  GetCategoryAggregateOptions,
} from "./types.js";
import { notImplemented } from "./errors.js";

export function getCategoryAggregate(
  _userId: string,
  _category: BehaviorCategory,
  _opts?: GetCategoryAggregateOptions,
): Promise<CategoryAggregate> {
  return notImplemented();
}
