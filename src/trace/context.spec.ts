import { LogLevel, setLogLevel } from "../utils";
import { SampleMode, xrayBaggageSubsegmentKey, xraySubsegmentNamespace, Source } from "./constants";
import {
  convertToAPMParentID,
  convertToAPMTraceID,
  convertToSampleMode,
  convertTraceContext,
  extractTraceContext,
  readTraceContextFromXray,
  readTraceFromEvent,
  readStepFunctionContextFromEvent,
} from "./context";

let currentSegment: any;

jest.mock("aws-xray-sdk-core", () => {
  return {
    captureFunc: (subsegmentName: string, callback: (segment: any) => void) => {
      if (currentSegment) {
        callback(currentSegment);
      } else {
        throw Error("Unimplemented");
      }
    },
  };
});

beforeEach(() => {
  currentSegment = undefined;
  setLogLevel(LogLevel.NONE);
});

describe("convertToAPMTraceID", () => {
  it("converts an xray trace id to a Datadog trace ID", () => {
    const xrayTraceID = "1-5ce31dc2-2c779014b90ce44db5e03875";
    const traceID = convertToAPMTraceID(xrayTraceID);
    expect(traceID).toEqual("4110911582297405557");
  });
  it("converts an xray trace id to a Datadog trace ID removing first bit", () => {
    const xrayTraceID = "1-5ce31dc2-ac779014b90ce44db5e03875"; // Number with 64bit toggled on
    const traceID = convertToAPMTraceID(xrayTraceID);
    expect(traceID).toEqual("4110911582297405557");
  });
  it("returns undefined when xray trace id is too short", () => {
    const xrayTraceID = "1-5ce31dc2-5e03875";
    const traceID = convertToAPMTraceID(xrayTraceID);
    expect(traceID).toBeUndefined();
  });

  it("returns undefined when xray trace id is in an invalid format", () => {
    const xrayTraceID = "1-2c779014b90ce44db5e03875";
    const traceID = convertToAPMTraceID(xrayTraceID);
    expect(traceID).toBeUndefined();
  });
  it("returns undefined when xray trace id uses invalid characters", () => {
    const xrayTraceID = "1-5ce31dc2-c779014b90ce44db5e03875;";
    const traceID = convertToAPMTraceID(xrayTraceID);
    expect(traceID).toBeUndefined();
  });
});

describe("convertToAPMParentID", () => {
  it("converts an xray parent ID to an APM parent ID", () => {
    const xrayParentID = "0b11cc4230d3e09e";
    const parentID = convertToAPMParentID(xrayParentID);
    expect(parentID).toEqual("797643193680388254");
  });
  it("returns undefined when parent ID uses invalid characters", () => {
    const xrayParentID = ";79014b90ce44db5e0;875";
    const parentID = convertToAPMParentID(xrayParentID);
    expect(parentID).toBeUndefined();
  });
  it("returns undefined when parent ID is wrong size", () => {
    const xrayParentID = "5e03875";
    const parentID = convertToAPMParentID(xrayParentID);
    expect(parentID).toBeUndefined();
  });
});

describe("convertToSampleMode", () => {
  it("returns USER_KEEP if xray was sampled", () => {
    const result = convertToSampleMode(1);
    expect(result).toBe(SampleMode.USER_KEEP);
  });
  it("returns USER_REJECT if xray wasn't sampled", () => {
    const result = convertToSampleMode(0);
    expect(result).toBe(SampleMode.USER_REJECT);
  });
});

describe("convertTraceContext", () => {
  it("converts a valid xray trace header", () => {
    const result = convertTraceContext({
      parentID: "0b11cc4230d3e09e",
      sampled: 1,
      traceID: "1-5ce31dc2-ac779014b90ce44db5e03875",
    });
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: Source.Xray,
    });
  });
  it("returns undefined if traceID is invalid", () => {
    const result = convertTraceContext({
      parentID: "0b11cc4230d3e09e",
      sampled: 1,
      traceID: "1-5ce31dc2",
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined if parentID is invalid", () => {
    const result = convertTraceContext({
      parentID: "0b11cc4230d;09e",
      sampled: 1,
      traceID: "1-5ce31dc2-ac779014b90ce44db5e03875",
    });
    expect(result).toBeUndefined();
  });
});

describe("readTraceContextFromXray", () => {
  afterEach(() => {
    process.env["_X_AMZN_TRACE_ID"] = undefined;
  });
  it("returns a trace context from a valid env var", () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1";
    const context = readTraceContextFromXray();
    expect(context).toEqual({
      parentID: "10713633173203262661",
      sampleMode: 2,
      source: "xray",
      traceID: "3995693151288333088",
    });
  });
  it("returns undefined when given an invalid env var", () => {
    const badCases = [
      "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5",
      "Root=1-5e272390-8c398be037738dc042009320",
      "1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1",
      "Root=1-5e272390-8c398be037738dc042009320;94ae789b969f1cc5;Sampled=1",
      "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;1",
      "Root=a;Parent=94ae789b969f1cc5;Sampled=1",
      "Root=1-5e272390-8c398be037738dc042009320;Parent=b;Sampled=1",
      undefined,
    ];
    for (const badCase of badCases) {
      process.env["_X_AMZN_TRACE_ID"] = badCase;
      expect(readTraceContextFromXray()).toBeUndefined();
    }
  });
});

describe("readTraceFromEvent", () => {
  it("can read well formed event with headers", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: Source.Event,
    });
  });
  it("can read well formed headers with mixed casing", () => {
    const result = readTraceFromEvent({
      headers: {
        "X-Datadog-Parent-Id": "797643193680388254",
        "X-Datadog-Sampling-Priority": "2",
        "X-Datadog-Trace-Id": "4110911582297405557",
      },
    });
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: Source.Event,
    });
  });
  it("returns undefined when missing trace id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-sampling-priority": "2",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing parent id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing sampling priority id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing headers value", () => {
    const result = readTraceFromEvent({});
    expect(result).toBeUndefined();
  });
  it("returns undefined when event isn't object", () => {
    const result = readTraceFromEvent("some-value");
    expect(result).toBeUndefined();
  });
});

describe("readStepFunctionContextFromEvent", () => {
  const stepFunctionEvent = {
    dd: {
      Execution: {
        Name: "fb7b1e15-e4a2-4cb2-963f-8f1fa4aec492",
        StartTime: "2019-09-30T20:28:24.236Z",
      },
      State: {
        Name: "step-one",
        RetryCount: 2,
      },
      StateMachine: {
        Id: "arn:aws:states:us-east-1:601427279990:stateMachine:HelloStepOneStepFunctionsStateMachine-z4T0mJveJ7pJ",
        Name: "my-state-machine",
      },
    },
  } as const;
  it("reads a trace from an execution id", () => {
    const result = readStepFunctionContextFromEvent(stepFunctionEvent);
    expect(result).toEqual({
      "step_function.execution_id": "fb7b1e15-e4a2-4cb2-963f-8f1fa4aec492",
      "step_function.retry_count": 2,
      "step_function.state_machine_arn":
        "arn:aws:states:us-east-1:601427279990:stateMachine:HelloStepOneStepFunctionsStateMachine-z4T0mJveJ7pJ",
      "step_function.state_machine_name": "my-state-machine",
      "step_function.step_name": "step-one",
    });
  });
  it("returns undefined when event isn't an object", () => {
    const result = readStepFunctionContextFromEvent("event");
    expect(result).toBeUndefined();
  });
  it("returns undefined when event is missing datadogContext property", () => {
    const result = readStepFunctionContextFromEvent({});
    expect(result).toBeUndefined();
  });
  it("returns undefined when datadogContext is missing Execution property", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {},
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when Execution is missing Name field", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        Execution: {},
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when Name isn't a string", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        Execution: {
          Name: 12345,
        },
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when State isn't defined", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        State: undefined,
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when try retry count isn't a number", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        State: {
          ...stepFunctionEvent.dd.State,
          RetryCount: "1",
        },
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when try step name isn't a string", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        State: {
          ...stepFunctionEvent.dd.State,
          Name: 1,
        },
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when StateMachine is undefined", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        StateMachine: undefined,
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when StateMachineId isn't a string", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        StateMachine: {
          ...stepFunctionEvent.dd.StateMachine,
          Id: 1,
        },
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when StateMachineName isn't a string", () => {
    const result = readStepFunctionContextFromEvent({
      dd: {
        ...stepFunctionEvent.dd,
        StateMachine: {
          ...stepFunctionEvent.dd.StateMachine,
          Name: 1,
        },
      },
    });
    expect(result).toBeUndefined();
  });
});

describe("extractTraceContext", () => {
  afterEach(() => {
    process.env["_X_AMZN_TRACE_ID"] = undefined;
  });
  it("returns trace read from header as highest priority", () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = extractTraceContext({
      headers: {
        "x-datadog-parent-id": "797643193680388251",
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "4110911582297405551",
      },
    });
    expect(result).toEqual({
      parentID: "797643193680388251",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405551",
      source: Source.Event,
    });
  });
  it("returns trace read from env if no headers present", () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = extractTraceContext({});
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: "xray",
    });
  });
  it("returns trace read from env if no headers present", () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = extractTraceContext({});
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: "xray",
    });
  });

  it("adds step function metadata to xray", () => {
    const stepFunctionEvent = {
      dd: {
        Execution: {
          Name: "fb7b1e15-e4a2-4cb2-963f-8f1fa4aec492",
          StartTime: "2019-09-30T20:28:24.236Z",
        },
        State: {
          Name: "step-one",
          RetryCount: 2,
        },
        StateMachine: {
          Id: "arn:aws:states:us-east-1:601427279990:stateMachine:HelloStepOneStepFunctionsStateMachine-z4T0mJveJ7pJ",
          Name: "my-state-machine",
        },
      },
    } as const;
    const addMetadata = jest.fn();
    currentSegment = { addMetadata };
    extractTraceContext(stepFunctionEvent);
    expect(addMetadata).toHaveBeenCalledWith(
      xrayBaggageSubsegmentKey,
      {
        "step_function.execution_id": "fb7b1e15-e4a2-4cb2-963f-8f1fa4aec492",
        "step_function.retry_count": 2,
        "step_function.state_machine_arn":
          "arn:aws:states:us-east-1:601427279990:stateMachine:HelloStepOneStepFunctionsStateMachine-z4T0mJveJ7pJ",
        "step_function.state_machine_name": "my-state-machine",
        "step_function.step_name": "step-one",
      },
      xraySubsegmentNamespace,
    );
  });
});
