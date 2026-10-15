import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DisabledEmailSender, SmtpEmailSender } from './senders.js';
import { passwordResetEmail } from './templates.js';

/**
 * A minimal local SMTP server (plaintext, loopback only) that records what it receives. It
 * exercises the real SMTP conversation of `SmtpEmailSender`; it is not a real provider.
 */
function fakeSmtp(
  rejectRecipient = false,
): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    let data = false;
    let body = '';
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake.smtp ESMTP');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            data = false;
            received.push(body);
            body = '';
            reply('250 2.0.0 queued');
          } else {
            body += `${line}\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') reply('250 fake.smtp');
        else if (command === 'MAIL') reply('250 2.1.0 ok');
        else if (command === 'RCPT')
          reply(rejectRecipient ? '550 5.1.1 no such user' : '250 2.1.5 ok');
        else if (command === 'DATA') {
          data = true;
          reply('354 go ahead');
        } else if (command === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received });
    });
  });
}

describe('email senders', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('delivers through SMTP with the configured sender', async () => {
    const smtp = await fakeSmtp();
    servers.push(smtp.server);
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      from: 'OGC <no-reply@mail.ogc.test>',
      timeoutMs: 5_000,
    });
    const token = `ogc_pr_${'B'.repeat(43)}`;
    await sender.send(passwordResetEmail('ada@example.test', 'https://ogc.test', token, 30));
    sender.close();
    expect(smtp.received).toHaveLength(1);
    const message = smtp.received[0] ?? '';
    expect(message).toMatch(/From: OGC <no-reply@mail\.ogc\.test>/);
    expect(message).toMatch(/To: ada@example\.test/);
    expect(message).toMatch(/Auto-Submitted: auto-generated/);
    expect(message).toContain('reset-password#token=');
    expect(sender.available).toBe(true);
  });

  it('rejects with a generic error when the provider refuses, without echoing the address', async () => {
    const smtp = await fakeSmtp(true);
    servers.push(smtp.server);
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      from: 'no-reply@mail.ogc.test',
      timeoutMs: 5_000,
    });
    const failure = sender.send(
      passwordResetEmail('nobody@example.test', 'https://ogc.test', `ogc_pr_${'C'.repeat(43)}`, 30),
    );
    await expect(failure).rejects.toThrow(/^Email delivery failed/);
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('nobody@example.test');
      expect(String(error)).not.toContain('ogc_pr_');
    });
    sender.close();
  });

  it('fails clearly when the provider cannot be reached', async () => {
    const smtp = await fakeSmtp();
    const { port } = smtp;
    smtp.server.close();
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port,
      security: 'none',
      from: 'no-reply@mail.ogc.test',
      timeoutMs: 2_000,
    });
    await expect(
      sender.send(
        passwordResetEmail('a@example.test', 'https://ogc.test', `ogc_pr_${'D'.repeat(43)}`, 30),
      ),
    ).rejects.toThrow(/Email delivery failed/);
    sender.close();
  });

  it('never claims delivery when no provider is configured', () => {
    expect(new DisabledEmailSender().available).toBe(false);
  });
});
