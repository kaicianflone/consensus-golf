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

  private async graphql<T>(query: string): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) {
      throw new RunPodsApiError(`RunPods API HTTP ${res.status}: ${res.statusText}`)
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

  async createPod(config: RunPodsConfig, name: string, sshPublicKey?: string): Promise<string> {
    const env = sshPublicKey ? `env: [{ key: "PUBLIC_KEY", value: ${JSON.stringify(sshPublicKey)} }]` : ''
    const templatePart = config.templateId ? `templateId: "${config.templateId}"` : `imageName: "${config.containerImage}"`
    const volumePart = config.volumeId ? `networkVolumeId: "${config.volumeId}"` : ''
    const volumeMountPath = config.volumeMountPath ?? '/workspace'
    const containerDisk = config.containerDiskInGb ?? 20
    const volumeGb = config.volumeInGb ?? 0

    const query = `mutation {
      podFindAndDeployOnDemand(input: {
        cloudType: ALL
        gpuCount: ${config.gpuCount}
        containerDiskInGb: ${containerDisk}
        ${volumeGb > 0 ? `volumeInGb: ${volumeGb}` : ''}
        gpuTypeId: "${config.gpuType}"
        name: "${name}"
        ${templatePart}
        ports: "22/tcp"
        volumeMountPath: "${volumeMountPath}"
        ${volumePart}
        ${env}
      }) {
        id
        desiredStatus
        costPerHr
        machine { podHostId }
      }
    }`

    const data = await this.graphql<{ podFindAndDeployOnDemand: { id: string } }>(query)
    return data.podFindAndDeployOnDemand.id
  }

  async getPodStatus(podId: string): Promise<PodInfo> {
    const query = `query {
      pod(input: { podId: "${podId}" }) {
        id
        desiredStatus
        costPerHr
        runtime {
          uptimeInSeconds
          ports {
            ip
            isIpPublic
            privatePort
            publicPort
            type
          }
        }
      }
    }`

    const data = await this.graphql<{ pod: PodInfo }>(query)
    return data.pod
  }

  async waitForRunning(podId: string, timeoutMs = 120_000, pollIntervalMs = 5_000): Promise<PodInfo> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = await this.getPodStatus(podId)
      if (info.desiredStatus === 'RUNNING' && info.runtime?.ports && info.runtime.ports.length > 0) {
        return info
      }
      if (info.desiredStatus === 'EXITED' || info.desiredStatus === 'ERROR') {
        throw new RunPodsApiError(`Pod ${podId} entered ${info.desiredStatus} status`)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    throw new RunPodsApiError(`Pod ${podId} did not reach RUNNING within ${timeoutMs}ms`)
  }

  async terminatePod(podId: string): Promise<void> {
    const query = `mutation { podTerminate(input: { podId: "${podId}" }) }`
    await this.graphql(query)
  }

  async stopPod(podId: string): Promise<void> {
    const query = `mutation { podStop(input: { podId: "${podId}" }) { id desiredStatus } }`
    await this.graphql(query)
  }

  /**
   * Execute a command on a running pod via SSH proxy.
   * Uses ssh {podId}@ssh.runpod.io to connect.
   * Returns the combined stdout/stderr output.
   */
  async executeCommand(podId: string, command: string, timeoutMs = 900_000): Promise<string> {
    const { spawn } = await import('child_process')

    return new Promise<string>((resolve, reject) => {
      let output = ''
      const sshArgs = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', `ConnectTimeout=30`,
        `${podId}@ssh.runpod.io`,
        command,
      ]

      const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new RunPodsApiError(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 || output.includes('final_int8_zlib_roundtrip')) {
          resolve(output)
        } else {
          // Training may exit non-zero but still produce useful output
          resolve(output)
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new RunPodsApiError(`SSH error: ${err.message}`))
      })
    })
  }

  /**
   * Upload file content to a pod via SSH cat heredoc.
   * No runpodctl dependency required.
   */
  async uploadScript(podId: string, content: string, remotePath: string): Promise<void> {
    // Escape single quotes in content for heredoc
    const escaped = content.replace(/'/g, "'\\''")
    const command = `cat > ${remotePath} << 'CGOLF_SCRIPT_EOF'\n${content}\nCGOLF_SCRIPT_EOF`
    await this.executeCommand(podId, command, 30_000)
  }
}
