#!/bin/sh
# Roda a sequência completa dos experimentos sem supervisão (ex.: durante a noite).
#
#   sh scripts/rodar-tudo.sh            # em primeiro plano
#   nohup sh scripts/rodar-tudo.sh &    # independente do terminal
#
# - Mantém o Mac acordado (caffeinate) enquanto roda.
# - Se o processo cair (ex.: o Docker reiniciou), espera 1 min e continua de
#   onde parou (`pnpm experimento tudo` é retomável), até 5 tentativas.
# - Log em results/rodar-tudo.log.
cd "$(dirname "$0")/.." || exit 1
LOG=results/rodar-tudo.log
mkdir -p results

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
avisar() { osascript -e "display notification \"$1\" with title \"TCC: experimentos\"" 2>/dev/null; }

aguardar_docker() {
  docker info >/dev/null 2>&1 && return 0
  log "Docker parado; iniciando o Docker Desktop…"
  open -a Docker 2>/dev/null
  i=0
  while ! docker info >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { log "Docker não respondeu em 5 min."; return 1; }
    sleep 5
  done
}

# Começa com o Docker recém-iniciado: a VM acumula estado ao longo de horas
# (no ensaio, a latência degradou após ~3,5 h e só se recuperou reiniciando).
if docker info >/dev/null 2>&1; then
  log "Reiniciando o Docker Desktop antes de começar…"
  docker desktop restart >/dev/null 2>&1
fi

tentativa=1
while [ "$tentativa" -le 5 ]; do
  log "Tentativa $tentativa de 5"
  if aguardar_docker && caffeinate -dimsu pnpm experimento tudo >>"$LOG" 2>&1; then
    log "CONCLUÍDO. Próximo passo: pnpm analise"
    avisar "Concluído. Resultados em results/final/"
    exit 0
  fi
  log "O processo parou com erro; continuando de onde parou em 1 min."
  tentativa=$((tentativa + 1))
  sleep 60
done
log "FALHOU após 5 tentativas. Veja o log acima."
avisar "Falhou após 5 tentativas. Veja results/rodar-tudo.log"
exit 1
