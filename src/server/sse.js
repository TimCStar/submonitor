export class EventBroker {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const response of this.clients) response.write(": heartbeat\n\n");
    }, 25000);
    this.heartbeat.unref();
  }

  connect(request, response) {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write("event: connected\ndata: {}\n\n");
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  emit(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of this.clients) response.write(frame);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}
