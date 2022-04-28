import { URL } from "url";

import axios, { AxiosRequestConfig } from "axios";

/**
 * The event payload structure for sending data to Inngest
 */
export interface EventPayload {
  /**
   * A unique identifier for the event
   */
  name: string;
  /**
   * Any data pertinent to the event
   */
  data: {
    [key: string]: any;
  };
  /**
   * Any user data associated with the event
   * All fields ending in "_id" will be used to attribute the event to a particular user
   */
  user?: {
    /**
     * Your user's unique id in your system
     */
    external_id?: string;
    /**
     * Your user's email address
     */
    email?: string;
    /**
     * Your user's phone number
     */
    phone?: string;
    [key: string]: any;
  };
  /**
   * A specific event schema version
   * (optional)
   */
  v?: string;
  /**
   * An integer representing the milliseconds since the unix epoch at which this event occurred.
   * Defaults to the current time.
   * (optional)
   */
  ts?: number;
}

/**
 * A set of options for configuring the Inngest client
 */
export interface InngestClientOptions {
  /**
   * The base Inngest Source API URL to append the Source API Key to.
   * Defaults to https://inn.gs/e/
   */
  inngestApiUrl?: string;
}

/**
 * A client for the Inngest Source API
 */
class Inngest {
  /**
   * Inngest Source API Key
   */
  private apiKey: string;

  /**
   * Full URL for the Inngest Source API
   */
  private inngestApiUrl: string;

  /**
   * Axios configuration for sending events to Inngest
   */
  private axiosConfig: AxiosRequestConfig;

  /**
   * @param apiKey - An API Key for the Inngest Source API
   */
  constructor(
    apiKey: string,
    { inngestApiUrl = "https://inn.gs/e/" }: InngestClientOptions = {}
  ) {
    this.apiKey = apiKey;
    this.inngestApiUrl = new URL(this.apiKey, inngestApiUrl).toString();

    this.axiosConfig = {
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "InngestJS 0.1.0",
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    };
  }

  /**
   * Send an event to Inngest
   */
  public async send(payload: EventPayload): Promise<boolean> {
    const response = await axios.post(
      this.inngestApiUrl,
      payload,
      this.axiosConfig
    );
    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    let errorMessage = "Unknown error";
    switch (response.status) {
      case 401:
        errorMessage = "API Key Not Found";
        break;
      case 400:
        errorMessage = "Cannot process event payload";
        break;
      case 403:
        errorMessage = "Forbidden";
        break;
      case 404:
        errorMessage = "API Key not found";
        break;
      case 406:
        errorMessage = `${JSON.stringify(response.data)}`;
        break;
      case 409:
      case 412:
        errorMessage = "Event transformation failed";
        break;
      case 413:
        errorMessage = "Event payload too large";
        break;
      case 500:
        errorMessage = "Internal server error";
        break;
    }

    throw new Error(`Inngest API Error: ${response.status} ${errorMessage}`);
  }
}

export { Inngest };
