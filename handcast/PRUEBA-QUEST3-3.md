# Prueba en Quest 3 (3): la música adaptativa

Cambio nuevo: cada tablero tiene un ritmo suave en su tonalidad. Cada cristal que una
mano de cristal mantiene encendido añade su propia voz (su nota, con su propio ritmo),
y debajo suena un bajo tipo latido. Sin cristales encendidos solo suena el fondo
tranquilo de siempre. Al resolver el tablero suena el arreglo completo.

1. Abre https://mghprojects.github.io/Devpost/?perf=1 en el Quest Browser y entra en XR.
2. Menu > TOUR. En el tablero 1 enciende un cristal con una mano de cristal: debe entrar
   un bajo suave y una nota rítmica al empezar el compás.
3. Enciende un segundo cristal: se suma otra voz que encaja con la primera (no la duplica).
4. Tira una mano de cristal con el puño: su voz se calla.
5. Abre el menú del sistema (botón Meta) y vuelve: la música se pausa y retoma a tiempo.
6. Dime:
   - ¿Se oye bien el volumen (ni tapa los efectos ni desaparece)?
   - ¿Molesta tras varios minutos? (si sí, lo dejo más sutil o solo al resolver)
   - El informe `?perf=1` al final: % de frames perdidos (antes 0,7 % a 72 Hz).
