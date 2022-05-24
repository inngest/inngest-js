import { expect, jest, it } from "@jest/globals";

import { Inngest } from "./index";

import axios, { AxiosResponse } from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("InngestJS", () => {
  describe("Inngest constructor", () => {
    it("should initialize without an error", () => {
      const inngest = new Inngest("test-key");
      expect(inngest).toBeDefined();
    });
    it("should accept options", () => {
      const inngest = new Inngest("test-key");
      expect(inngest).toBeDefined();
    });
  });

  describe("send", () => {
    it("should send an event", async () => {
      const response: AxiosResponse = {
        status: 200,
        statusText: "OK",
        data: "OK",
        headers: {},
        config: {},
        request: {},
      };
      mockedAxios.post.mockResolvedValueOnce(response);

      const inngest = new Inngest("test-key");
      const event = {
        name: "test-event",
        data: {
          test: "test",
        },
      };
      const result = await inngest.send(event);
      expect(axios.post).toHaveBeenCalled();
      expect(result).toBe(true);
      console.log(result);
    });

    it("should send multiple events", async () => {
      const response: AxiosResponse = {
        status: 200,
        statusText: "OK",
        data: "OK",
        headers: {},
        config: {},
        request: {},
      };
      mockedAxios.post.mockResolvedValueOnce(response);

      const inngest = new Inngest("test-key");
      const events = [
        {
          name: "test-event",
          data: {
            test: "one",
          },
        },
        {
          name: "test-event",
          data: {
            test: "two",
          },
        },
      ];
      const result = await inngest.send(events);
      expect(axios.post).toHaveBeenCalled();
      expect(result).toBe(true);
      console.log(result);
    });

    it("should throw an error with a non 2xx response", async () => {
      const response: AxiosResponse = {
        status: 401,
        statusText: "Unauthorized",
        data: "",
        headers: {},
        config: {},
        request: {},
      };

      // Use "resolved" since we set "validateStatus" to true
      mockedAxios.post.mockResolvedValueOnce(response);

      const inngest = new Inngest("test-key");
      const event = {
        name: "test-event",
        data: {
          test: "test",
        },
      };
      expect(async () => {
        await inngest.send(event);
      }).rejects.toThrow();
      expect(axios.post).toHaveBeenCalled();
    });
  });

  it("should return the error message for 406 responses", async () => {
    const response: AxiosResponse = {
      status: 406,
      statusText: "Not Acceptable",
      data: "event name is empty",
      headers: {},
      config: {},
      request: {},
    };

    mockedAxios.post.mockResolvedValueOnce(response);

    const inngest = new Inngest("test-key");
    const event = {
      name: "",
      data: {
        test: "test",
      },
    };
    expect(async () => {
      await inngest.send(event);
    }).rejects.toThrowError(/event name is empty/);
    expect(axios.post).toHaveBeenCalled();
  });
});
