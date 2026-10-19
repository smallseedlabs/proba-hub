import type { FastifyInstance } from 'fastify';

interface WaitForOptions {
  timeout?: number;
  interval?: number;
}

export async function waitForEvents(
  app: FastifyInstance,
  token: string,
  predicate: (events: any[]) => boolean,
  options: WaitForOptions = {}
): Promise<any[]> {
  const { timeout = 10000, interval = 100 } = options;
  const start = Date.now();
  
  let lastSeq = 0;
  let allEvents: any[] = [];
  
  while (Date.now() - start < timeout) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/events?after=${lastSeq}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    
    if (response.statusCode === 200) {
      const data = JSON.parse(response.body);
      if (data.events && data.events.length > 0) {
        allEvents = [...allEvents, ...data.events];
        lastSeq = data.nextSeq;
        
        if (predicate(allEvents)) {
          return allEvents;
        }
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error(`waitForEvents timeout after ${timeout}ms. Got ${allEvents.length} events: ${JSON.stringify(allEvents.map((e: any) => e.type))}`);
}
