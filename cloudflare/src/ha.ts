import type { Env } from "./index";

/**
 * Minimal client for calling back into Home Assistant's REST API, e.g. so
 * ROSE can read entity state or call a service while composing a reply.
 * See: https://developers.home-assistant.io/docs/api/rest/
 */
export class HomeAssistantClient {
  constructor(private readonly env: Env) {}

  get isConfigured(): boolean {
    return Boolean(this.env.HA_URL && this.env.HA_TOKEN);
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.env.HA_TOKEN}`,
      "content-type": "application/json",
    };
  }

  async getState(entityId: string): Promise<unknown> {
    if (!this.isConfigured) {
      throw new Error("Home Assistant is not configured (HA_URL / HA_TOKEN)");
    }
    const res = await fetch(`${this.env.HA_URL}/api/states/${entityId}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`HA getState(${entityId}) failed: ${res.status}`);
    }
    return res.json();
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.isConfigured) {
      throw new Error("Home Assistant is not configured (HA_URL / HA_TOKEN)");
    }
    const res = await fetch(`${this.env.HA_URL}/api/services/${domain}/${service}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(serviceData),
    });
    if (!res.ok) {
      throw new Error(`HA callService(${domain}.${service}) failed: ${res.status}`);
    }
    return res.json();
  }
}
