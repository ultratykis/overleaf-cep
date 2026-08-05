import "../../../../../test/acceptance/src/helpers/InitApp.mjs";
import MockClsiApi from "../../../../../test/acceptance/src/mocks/MockClsiApi.mjs";
import MockDocstoreApi from "../../../../../test/acceptance/src/mocks/MockDocstoreApi.mjs";
import MockDocUpdaterApi from "../../../../../test/acceptance/src/mocks/MockDocUpdaterApi.mjs";
import MockProjectHistoryApi from "../../../../../test/acceptance/src/mocks/MockProjectHistoryApi.mjs";

const mockOptions = {
  debug: ["1", "true", "TRUE"].includes(process.env.DEBUG_MOCKS),
};

MockClsiApi.initialize(23013, mockOptions);
MockDocstoreApi.initialize(23016, mockOptions);
MockDocUpdaterApi.initialize(23003, mockOptions);
MockProjectHistoryApi.initialize(23054, mockOptions);
