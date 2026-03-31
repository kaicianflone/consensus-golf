export class RunPodsApiError extends Error {
  constructor(message: string, public readonly errors?: unknown[]) {
    super(message)
    this.name = 'RunPodsApiError'
  }
}

export interface RunPodsConfig {
  gpuType: string
  gpuCount: number
  templateId: string
  containerImage: string
  volumeId: string
  volumeMountPath?: string
  containerDiskInGb?: number
  volumeInGb?: number
}

export interface PodInfo {
  id: string
  desiredStatus: string
  costPerHr?: number
  runtime?: {
    uptimeInSeconds?: number
    ports?: Array<{
      ip: string
      isIpPublic: boolean
      privatePort: number
      publicPort: number
      type: string
    }>
  }
}

export class RunPodsClient {
  private readonly endpoint: string

  constructor(private readonly apiKey: string) {
    this.endpoint = `https://api.runpod.io/graphql?api_key=${apiKey}`
  }

  private validatePodId(podId: string): void {
    if (!/^[a-z0-9\-]+$/.test(podId)) {
      throw new RunPodsApiError(`Invalid pod ID: ${podId}`)
    }
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const body: Record<string, unknown> = { query }
    if (variables) body.variables = variables
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RunPodsApiError(`RunPods API HTTP ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`)
    }
    const json = await res.json() as { data?: T; errors?: unknown[] }
    if (json.errors) {
      throw new RunPodsApiError(`RunPods API error: ${JSON.stringify(json.errors)}`, json.errors)
    }
    if (!json.data) {
      throw new RunPodsApiError('RunPods API returned no data')
    }
    return json.data
  }

  async createPod(config: RunPodsConfig, name: string, options?: { dockerArgs?: string; env?: Array<{ key: string; value: string }> }): Promise<string> {
    const input: Record<string, unknown> = {
      cloudType: 'ALL',
      gpuCount: config.gpuCount,
      containerDiskInGb: config.containerDiskInGb ?? 40,
      gpuTypeId: config.gpuType,
      name,
      ports: '22/tcp',
      volumeMountPath: config.volumeMountPath ?? '/workspace',
    }
    if (config.templateId) input.templateId = config.templateId
    else input.imageName = config.containerImage
    if (config.volumeId) input.networkVolumeId = config.volumeId
    if (options?.env?.length) input.env = options.env
    if (options?.dockerArgs) input.dockerArgs = options.dockerArgs

    const query = `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id desiredStatus costPerHr machine { podHostId }
      }
    }`

    const data = await this.graphql<{ podFindAndDeployOnDemand: { id: string } }>(query, { input })
    return data.podFindAndDeployOnDemand.id
  }

  async getPodStatus(podId: string): Promise<PodInfo> {
    this.validatePodId(podId)
    const query = `query GetPod {
      pod(input: {podId: "${podId}"}) {
        id desiredStatus costPerHr
        runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } }
      }
    }`

    const data = await this.graphql<{ pod: PodInfo }>(query)
    return data.pod
  }

  async waitForRunning(podId: string, timeoutMs = 120_000, pollIntervalMs = 5_000): Promise<PodInfo> {
    const deadline = Date.now() + timeoutMs
    let consecutiveErrors = 0
    while (Date.now() < deadline) {
      try {
        const info = await this.getPodStatus(podId)
        consecutiveErrors = 0
        if (info.desiredStatus === 'RUNNING' && info.runtime?.ports && info.runtime.ports.length > 0) {
          return info
        }
        if (info.desiredStatus === 'EXITED' || info.desiredStatus === 'ERROR') {
          throw new RunPodsApiError(`Pod ${podId} entered ${info.desiredStatus} status`)
        }
      } catch (err) {
        // Re-throw terminal pod states immediately (EXITED/ERROR)
        if (err instanceof RunPodsApiError && /entered (EXITED|ERROR) status/.test(err.message)) {
          throw err
        }
        // Pods in transitional states can return 400/500 — retry up to 5 times
        consecutiveErrors++
        if (consecutiveErrors >= 5) throw err
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    throw new RunPodsApiError(`Pod ${podId} did not reach RUNNING within ${timeoutMs}ms`)
  }

  async terminatePod(podId: string): Promise<void> {
    const query = `mutation TerminatePod($input: PodTerminateInput!) { podTerminate(input: $input) }`
    await this.graphql(query, { input: { podId } })
  }

  async stopPod(podId: string): Promise<void> {
    const query = `mutation StopPod($input: PodStopInput!) { podStop(input: $input) { id desiredStatus } }`
    await this.graphql(query, { input: { podId } })
  }

  async getSshAddress(podId: string): Promise<string> {
    this.validatePodId(podId)
    const query = `query GetPodSsh { pod(input: {podId: "${podId}"}) { machine { podHostId } } }`
    const data = await this.graphql<{ pod: { machine: { podHostId: string } } }>(query)
    return `${data.pod.machine.podHostId}@ssh.runpod.io`
  }

  /**
   * Execute a command on a running pod via SSH.
   *
   * Uses `-tt` to force PTY allocation (required by RunPods SSH proxy) and
   * pipes the command through stdin. Returns combined stdout/stderr.
   *
   * Requires ~/.ssh/id_ed25519 key registered in RunPods account settings.
   */
  async executeCommand(podId: string, command: string, timeoutMs = 900_000, sshKeyPath = '~/.ssh/id_ed25519'): Promise<string> {
    const { spawn } = await import('child_process')
    const sshAddress = await this.getSshAddress(podId)
    const resolvedKeyPath = sshKeyPath.replace('~', process.env.HOME ?? '')

    return new Promise<string>((resolve, reject) => {
      let output = ''
      const child = spawn('ssh', [
        '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=30',
        '-i', resolvedKeyPath,
        sshAddress,
        'bash',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new RunPodsApiError(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

      // Pipe the command + exit through stdin
      child.stdin?.write(command + '\nexit\n')
      child.stdin?.end()

      child.on('close', () => {
        clearTimeout(timer)
        resolve(output)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new RunPodsApiError(`SSH error: ${err.message}`))
      })
    })
  }

  /**
   * Upload file content to a pod via heredoc over SSH stdin.
   * RunPod requires PTY (-tt), so we disable echo first to prevent the PTY
   * from reflecting the entire base64 payload back through stdout.
   */
  async uploadScript(podId: string, content: string, remotePath: string): Promise<void> {
    if (!/^[a-zA-Z0-9_.\-\/]+$/.test(remotePath)) {
      throw new RunPodsApiError(`Unsafe remote path: ${remotePath}`)
    }
    const b64 = Buffer.from(content).toString('base64')

    const cmd = [
      'stty -echo 2>/dev/null',
      `cat > /tmp/cgolf_upload.b64 << 'CGOLF_EOF'`,
      b64,
      'CGOLF_EOF',
      `base64 -d /tmp/cgolf_upload.b64 > ${remotePath}`,
      'rm /tmp/cgolf_upload.b64',
      'stty echo 2>/dev/null',
      `echo UPLOADED $(wc -c < ${remotePath}) bytes`,
    ].join('\n')

    const output = await this.executeCommand(podId, cmd, 120_000)
    if (!output.includes('UPLOADED')) {
      throw new RunPodsApiError(`Script upload failed: ${output.slice(-300)}`)
    }
  }
}
