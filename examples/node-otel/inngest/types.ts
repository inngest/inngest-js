import { EventSchemas, type MetadataTarget } from "inngest";

type DemoEventSent = {
  name: "demo/event.sent";
  data: {
    message: string;
  };
};

type MetadataDemoTriggered = {
  name: "demo/metadata.triggered";
  data: {
    message: string;
    propagateTo?: MetadataTarget;
  };
};

export const schemas = new EventSchemas().fromUnion<
  DemoEventSent | MetadataDemoTriggered
>();
