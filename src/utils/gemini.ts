        state: meta.state ?? 'ACTIVE',
        expiresAt: meta.expirationTime 
          ? new Date(meta.expirationTime).getTime() 
          : undefined
      };
    });
  }

  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const meta = await this.ai.files.get({ name });
      return meta.state ?? 'UNKNOWN';
    } catch (e) {
      console.warn('getFileStatus failed:', e);
      return 'FAILED';
    }
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('deleteFile failed:', e);
    }
  }
}

export default GeminiClient;
