import { readdir, readFile } from "node:fs/promises";
import Path from "node:path";

import logger from "@overleaf/logger";
import logSerializers from "@overleaf/logger/serializers.js";
import Settings from "@overleaf/settings";

import AnalyticsManager from "../../../../../../app/src/Features/Analytics/AnalyticsManager.mjs";
import RedisWrapper from "../../../../../../app/src/infrastructure/RedisWrapper.mjs";
import {
  getCollectionInternal,
  getCollectionNames,
} from "../../../../../../app/src/infrastructure/mongodb.mjs";

const analyticsWriteMethods = [
  "identifyUser",
  "recordEventForSession",
  "recordEventForUser",
  "recordEventForUserInBackground",
  "recordEventForMongoUser",
  "recordEventForMongoUserInBackground",
  "emitPackageUsage",
  "setUserPropertyForUser",
  "setUserPropertyForUserInBackground",
  "setUserPropertyForMongoUser",
  "setUserPropertyForMongoUserInBackground",
  "setUserPropertyForSession",
  "setUserPropertyForSessionInBackground",
  "setUserPropertyForAnalyticsId",
  "updateEditingSession",
  "registerAccountMapping",
  "registerEmailChange",
];

function containsSentinel(value, sentinel, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") {
    return value.includes(sentinel);
  }
  if (Buffer.isBuffer(value)) {
    return value.includes(Buffer.from(sentinel));
  }
  if (value == null || typeof value !== "object" || depth > 12) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (value instanceof Error && value.message.includes(sentinel)) {
    return true;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      key.includes(sentinel) ||
      containsSentinel(nested, sentinel, seen, depth + 1),
  );
}

function serializeLogArguments(arguments_) {
  return arguments_.map((argument) => {
    if (argument == null || typeof argument !== "object") {
      return argument;
    }

    const serialized = { ...argument };
    for (const [name, serializer] of Object.entries(logSerializers)) {
      if (name in serialized) {
        serialized[name] = serializer(serialized[name]);
      }
    }
    return serialized;
  });
}

async function mongoContainsSentinel(sentinel) {
  for (const collectionName of await getCollectionNames()) {
    const collection = await getCollectionInternal(collectionName);
    const documents = await collection.find({}).toArray();
    if (containsSentinel(documents, sentinel)) {
      return `MongoDB collection ${collectionName}`;
    }
  }
  return null;
}

async function redisValue(client, key) {
  switch (await client.type(key)) {
    case "string":
      return await client.getBuffer(key);
    case "hash":
      return await client.hgetall(key);
    case "list":
      return await client.lrange(key, 0, -1);
    case "set":
      return await client.smembers(key);
    case "zset":
      return await client.zrange(key, 0, -1, "WITHSCORES");
    case "stream":
      return await client.xrange(key, "-", "+");
    default:
      return await client.dump(key);
  }
}

async function redisContainsSentinel(clients, sentinel) {
  for (const { feature, client } of clients) {
    for (const key of await client.keys("*")) {
      if (containsSentinel(key, sentinel)) {
        return `Redis ${feature} key`;
      }
      if (containsSentinel(await redisValue(client, key), sentinel)) {
        return `Redis ${feature} value`;
      }
    }
  }
  return null;
}

async function directoryContainsSentinel(directory, sentinel) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = Path.join(directory, entry.name);
    if (entry.name.includes(sentinel)) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await directoryContainsSentinel(entryPath, sentinel);
      if (nested != null) {
        return nested;
      }
    } else if (entry.isFile()) {
      const content = await readFile(entryPath);
      if (content.includes(Buffer.from(sentinel))) {
        return entryPath;
      }
    }
  }
  return null;
}

export function createPrivacySinkProbe(sandbox) {
  const loggerSpies = ["trace", "debug", "info", "warn", "error", "fatal"]
    .filter((level) => typeof logger[level] === "function")
    .map((level) => ({ level, spy: sandbox.spy(logger, level) }));
  const analyticsStubs = analyticsWriteMethods
    .filter((name) => typeof AnalyticsManager[name] === "function")
    .map((name) => ({
      name,
      stub: sandbox.stub(AnalyticsManager, name).callsFake(() => {}),
    }));
  const redisClients = ["web", "websessions", "ratelimiter"].map((feature) => ({
    feature,
    client: RedisWrapper.client(feature),
  }));

  return {
    async findSentinel(sentinel) {
      for (const { level, spy } of loggerSpies) {
        if (
          containsSentinel(
            spy.getCalls().map((call) => serializeLogArguments(call.args)),
            sentinel,
          )
        ) {
          return `serialized logger.${level}`;
        }
      }
      for (const { name, stub } of analyticsStubs) {
        if (
          containsSentinel(
            stub.getCalls().map((call) => call.args),
            sentinel,
          )
        ) {
          return `AnalyticsManager.${name}`;
        }
      }

      const mongoLocation = await mongoContainsSentinel(sentinel);
      if (mongoLocation != null) {
        return mongoLocation;
      }
      const redisLocation = await redisContainsSentinel(redisClients, sentinel);
      if (redisLocation != null) {
        return redisLocation;
      }
      for (const directory of [
        Settings.path.dumpFolder,
        Settings.path.uploadFolder,
      ]) {
        const fileLocation = await directoryContainsSentinel(
          directory,
          sentinel,
        );
        if (fileLocation != null) {
          return "configured filesystem persistence";
        }
      }
      return null;
    },
  };
}
