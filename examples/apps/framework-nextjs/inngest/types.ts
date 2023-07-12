type DemoEventSent = {
  name: "demo/event.sent";
  data: {
    message: string;
  };
};

export type Events = {
  "demo/event.sent": DemoEventSent;
};
