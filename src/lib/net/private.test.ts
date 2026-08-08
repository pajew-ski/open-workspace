import { describe, it, expect } from 'vitest';
import { isPrivateHostname, isLoopbackHostname, isMixedContentBlocked } from './private';

describe('isPrivateHostname', () => {
    it.each([
        'localhost', 'foo.localhost', '127.0.0.1', '127.5.5.5', '10.0.0.1',
        '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.169.254',
        '0.0.0.0', '::1', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1',
    ])('%s ist privat', host => {
        expect(isPrivateHostname(host)).toBe(true);
    });

    it.each(['example.com', '8.8.8.8', '172.32.0.1', 'api.openai.com'])('%s ist öffentlich', host => {
        expect(isPrivateHostname(host)).toBe(false);
    });
});

describe('isLoopbackHostname', () => {
    it('treats only loopback as loopback', () => {
        expect(isLoopbackHostname('localhost')).toBe(true);
        expect(isLoopbackHostname('127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('::1')).toBe(true);
        expect(isLoopbackHostname('192.168.1.10')).toBe(false);
    });
});

describe('isMixedContentBlocked', () => {
    it('blocks http on non-loopback targets from https pages', () => {
        expect(isMixedContentBlocked('http://192.168.1.10:11434', 'https:')).toBe(true);
        expect(isMixedContentBlocked('http://mein-nas.fritz.box', 'https:')).toBe(true);
    });

    it('allows loopback and https targets', () => {
        expect(isMixedContentBlocked('http://localhost:11434', 'https:')).toBe(false);
        expect(isMixedContentBlocked('http://127.0.0.1:1234', 'https:')).toBe(false);
        expect(isMixedContentBlocked('https://api.example', 'https:')).toBe(false);
    });

    it('never blocks from http pages', () => {
        expect(isMixedContentBlocked('http://192.168.1.10', 'http:')).toBe(false);
    });
});
