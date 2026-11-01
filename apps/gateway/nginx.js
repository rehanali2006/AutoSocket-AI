const fs = require('fs/promises');
const { spawn, execFile } = require('child_process');

const TEMP_DIR = '/tmp/nginx';

function createNginxProcess({ binary, configPath }) {
  let child = null;
  let stopping = false;

  function run(args) {
    return new Promise((resolve, reject) => {
      execFile(binary, args, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve();
      });
    });
  }

  function launch() {
    child = spawn(binary, ['-g', 'daemon off;', '-c', configPath], { stdio: 'inherit' });
    child.on('exit', code => {
      if (stopping) return;
      console.error(`[gateway] nginx exited with code ${code}`);
      process.exit(1);
    });
  }

  async function apply(text) {
    const candidate = `${configPath}.next`;
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(candidate, text);
    await run(['-t', '-c', candidate]);
    await fs.rename(candidate, configPath);

    if (!child) {
      launch();
      return;
    }
    await run(['-s', 'reload', '-c', configPath]);
  }

  function stop() {
    stopping = true;
    if (child) child.kill('SIGQUIT');
  }

  return { apply, stop };
}

module.exports = { createNginxProcess };