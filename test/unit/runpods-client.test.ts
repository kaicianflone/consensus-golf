import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RunPodsClient, RunPodsApiError } from '../../src/runner/runpods-client.js'
import type { RunPodsConfig } from '../../src/runner/runpods-client.js'

vi.stubGlobal('fetch', vi.fn())

function makeConfig(): RunPodsConfig {
  return {
    gpuType: 'NVIDIA H100 80GB HBM3',
    gpuCount: 1,
    templateId: '',
    containerImage: 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04',
    volumeId: '',
  }
}

describe('RunPodsClient', () => {
  let client: RunPodsClient

  beforeEach(() => {
    vi.mocked(fetch).mockReset()
    client = new RunPodsClient('test-api-key-123')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('API key included in endpoint URL', () => {
    // Verify by making a call and checking the URL
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: { podFindAndDeployOnDemand: { id: 'pod-123' } },
      }),
    } as any)

    client.createPod(makeConfig(), 'test-pod')

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      'https://api.runpod.io/graphql?api_key=test-api-key-123',
    )
  })

  it('createPod sends GraphQL mutation and returns podId', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: { podFindAndDeployOnDemand: { id: 'pod-123' } },
      }),
    } as any)

    const podId = await client.createPod(makeConfig(), 'test-pod')

    expect(podId).toBe('pod-123')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)

    const callBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(callBody.query).toContain('podFindAndDeployOnDemand')
    // Variables-based: GPU type should be in variables, not query string
    expect(callBody.variables.input.gpuTypeId).toBe('NVIDIA H100 80GB HBM3')
  })

  it('getPodStatus returns parsed PodInfo', async () => {
    const podInfo = {
      id: 'pod-456',
      desiredStatus: 'RUNNING',
      costPerHr: 2.49,
      runtime: {
        uptimeInSeconds: 120,
        ports: [
          { ip: '1.2.3.4', isIpPublic: true, privatePort: 22, publicPort: 22222, type: 'tcp' },
        ],
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { pod: podInfo } }),
    } as any)

    const result = await client.getPodStatus('pod-456')

    expect(result.id).toBe('pod-456')
    expect(result.desiredStatus).toBe('RUNNING')
    expect(result.costPerHr).toBe(2.49)
    expect(result.runtime?.ports).toHaveLength(1)
    expect(result.runtime?.ports?.[0].publicPort).toBe(22222)
  })

  it('waitForRunning polls until RUNNING', async () => {
    // First call: CREATED status (no ports)
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: { pod: { id: 'pod-789', desiredStatus: 'CREATED', runtime: null } },
      }),
    } as any)

    // Second call: RUNNING with ports
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: {
          pod: {
            id: 'pod-789',
            desiredStatus: 'RUNNING',
            costPerHr: 2.49,
            runtime: {
              uptimeInSeconds: 10,
              ports: [{ ip: '1.2.3.4', isIpPublic: true, privatePort: 22, publicPort: 22222, type: 'tcp' }],
            },
          },
        },
      }),
    } as any)

    const result = await client.waitForRunning('pod-789', 10_000, 10)

    expect(result.id).toBe('pod-789')
    expect(result.desiredStatus).toBe('RUNNING')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  it('waitForRunning throws on ERROR status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: { pod: { id: 'pod-err', desiredStatus: 'ERROR', runtime: null } },
      }),
    } as any)

    await expect(client.waitForRunning('pod-err', 10_000, 10)).rejects.toThrow(
      'Pod pod-err entered ERROR status',
    )
  })

  it('waitForRunning throws on timeout', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { pod: { id: 'pod-slow', desiredStatus: 'CREATED', runtime: null } },
      }),
    } as any)

    await expect(client.waitForRunning('pod-slow', 100, 10)).rejects.toThrow(
      'did not reach RUNNING within 100ms',
    )
  })

  it('terminatePod sends terminate mutation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    } as any)

    await client.terminatePod('pod-term')

    const callBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(callBody.query).toContain('podTerminate')
    // Variables-based: podId should be in variables, not query string
    expect(callBody.variables.input.podId).toBe('pod-term')
  })

  it('RunPodsApiError thrown on HTTP errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as any)

    const err = await client.getPodStatus('pod-fail').catch((e) => e)
    expect(err).toBeInstanceOf(RunPodsApiError)
    expect(err.message).toContain('RunPods API HTTP')
  })

  it('RunPodsApiError thrown on GraphQL errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        errors: [{ message: 'Invalid pod ID' }],
      }),
    } as any)

    const err = await client.getPodStatus('pod-bad').catch((e) => e)
    expect(err).toBeInstanceOf(RunPodsApiError)
    expect(err.message).toContain('RunPods API error')
  })

  // executeCommand and uploadScript use SSH - skip for unit tests
  it.todo('executeCommand - requires SSH integration test')
  it.todo('uploadScript - requires SSH integration test')
})
