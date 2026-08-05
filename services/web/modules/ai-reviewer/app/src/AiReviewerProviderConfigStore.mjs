// @ts-check

import { AiReviewerProviderConfig } from "../models/AiReviewerProviderConfig.mjs";
import { parseAiReviewerProviderConfig } from "./AiReviewerProviderConfig.mjs";

/** @param {any} record */
function storedConfig(record) {
  if (record == null) {
    return null;
  }
  return parseAiReviewerProviderConfig({
    provider: record.provider,
    baseUrl: record.baseUrl,
    model: record.model,
  });
}

/**
 * @param {{ model?: typeof AiReviewerProviderConfig }} [dependencies]
 */
export function createAiReviewerProviderConfigStore({
  model = AiReviewerProviderConfig,
} = {}) {
  return {
    /** @param {string} userId */
    async get(userId) {
      return storedConfig(await model.findOne({ _id: userId }).lean().exec());
    },

    /**
     * @param {string} userId
     * @param {unknown} input
     */
    async save(userId, input) {
      const config = parseAiReviewerProviderConfig(input);
      const record = await model
        .findOneAndUpdate(
          { _id: userId },
          { $set: config },
          {
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            upsert: true,
          },
        )
        .lean()
        .exec();
      return storedConfig(record);
    },
  };
}
