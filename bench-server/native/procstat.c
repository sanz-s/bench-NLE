// procstat: long-lived macOS process sampler for bench-server (replaces `ps` + `top`, which cost ~20 % of a core).
// For every newline read on stdin it prints one line per process, then "END":
//   pid \t ppid \t cpu_ns (user+system) \t phys_footprint_bytes \t resident_bytes \t executable path
// cpu comes from proc_pid_rusage (nanosecond precision; converted from Mach ticks on Apple Silicon) and
// phys_footprint is the Activity Monitor "Memory" figure (includes the process's owned graphics memory).
// Processes of other users are skipped unless bench-server runs as root.
// Built automatically by server.mjs:  clang -O2 -o procstat procstat.c
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <string.h>

// path cache: proc_pidpath() is the expensive call, so it runs only for pids not seen before (or whose name changed)
#define SLOTS 65536
static char *cache_path[SLOTS];
static char cache_comm[SLOTS][MAXCOMLEN + 1];
static pid_t cache_pid[SLOTS];

int main(void) {
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  int cap = 4096;
  pid_t *pids = malloc(sizeof(pid_t) * cap);
  char path[PROC_PIDPATHINFO_MAXSIZE];
  int c;
  while ((c = getchar()) != EOF) {
    if (c != '\n') continue;
    int n = proc_listallpids(pids, (int)(sizeof(pid_t) * cap));
    if (n >= cap) {
      cap = n * 2;
      pids = realloc(pids, sizeof(pid_t) * cap);
      n = proc_listallpids(pids, (int)(sizeof(pid_t) * cap));
    }
    for (int i = 0; i < n; i++) {
      pid_t pid = pids[i];
      if (pid <= 0) continue;
      struct rusage_info_v4 ru;
      if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ru) != 0) continue;
      struct proc_bsdshortinfo bi;
      if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &bi, sizeof(bi)) != (int)sizeof(bi)) continue;
      int slot = pid % SLOTS;
      if (cache_pid[slot] != pid || strncmp(cache_comm[slot], bi.pbsi_comm, MAXCOMLEN) != 0 || !cache_path[slot]) {
        if (proc_pidpath(pid, path, sizeof(path)) <= 0) snprintf(path, sizeof(path), "%s", bi.pbsi_comm);
        free(cache_path[slot]);
        cache_path[slot] = strdup(path);
        cache_pid[slot] = pid;
        strncpy(cache_comm[slot], bi.pbsi_comm, MAXCOMLEN);
        cache_comm[slot][MAXCOMLEN] = 0;
      }
      uint64_t ticks = ru.ri_user_time + ru.ri_system_time;
      uint64_t ns = ticks * tb.numer / tb.denom;
      printf("%d\t%d\t%llu\t%llu\t%llu\t%s\n", pid, bi.pbsi_ppid, (unsigned long long)ns, (unsigned long long)ru.ri_phys_footprint,
             (unsigned long long)ru.ri_resident_size, cache_path[slot]);
    }
    printf("END\n");
    fflush(stdout);
  }
  return 0;
}
