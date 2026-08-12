class Wr < Formula
  desc "Relationship ledger for tasks, CLI sessions, worktrees, and pull requests"
  homepage "https://github.com/mkusaka/wr"
  version "__VERSION__"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "__DARWIN_ARM64_URL__"
      sha256 "__DARWIN_ARM64_SHA256__"
    else
      url "__DARWIN_X64_URL__"
      sha256 "__DARWIN_X64_SHA256__"
    end
  end

  def install
    bin.install "wr"
    (pkgshare/"skills").install Dir["skills/*"]
  end

  def caveats
    skill_path = opt_pkgshare/"skills"
    <<~EOS
      Optional agent skills were installed to:
        #{skill_path}

      Install from the packaged skill files with npx skills:
        npx -y skills add "#{skill_path}" --skill operate-wr -y --copy

      Install from the repository with npx skills:
        npx -y skills add https://github.com/mkusaka/wr --skill operate-wr -y

      Install from GitHub CLI v2.90.0+:
        gh skill install mkusaka/wr operate-wr

      Add `--agent <host>` if you want to target a specific agent host.
    EOS
  end

  test do
    assert_match "relationship ledger", shell_output("#{bin}/wr --help")
  end
end
