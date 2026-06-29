/* =========================================================
   Red Lienzo — Datos de Estados y Ciudades/poblados de Venezuela
   =========================================================
   Se usa en dos lugares:
     1. El wizard de registro (paso de direccion), para que la
        persona seleccione Estado y luego Ciudad de listas
        desplegables, en vez de depender de un mapa.
     2. El modulo de Perfil del dashboard, para poder editar la
        "zona" (estado/ciudad) de un usuario ya registrado.

   La lista de ciudades/poblados no pretende ser exhaustiva (seria
   imposible cubrir cada caserio), pero cubre las capitales y las
   poblaciones mas relevantes de cada estado para que cualquier
   voluntario encuentre su zona o la mas cercana.
   ========================================================= */

export const ESTADOS_VENEZUELA = [
  "Amazonas",
  "Anzoátegui",
  "Apure",
  "Aragua",
  "Barinas",
  "Bolívar",
  "Carabobo",
  "Cojedes",
  "Delta Amacuro",
  "Distrito Capital",
  "Falcón",
  "Guárico",
  "Lara",
  "Mérida",
  "Miranda",
  "Monagas",
  "Nueva Esparta",
  "Portuguesa",
  "Sucre",
  "Táchira",
  "Trujillo",
  "La Guaira",
  "Yaracuy",
  "Zulia"
];

export const CIUDADES_POR_ESTADO = {
  "Amazonas": ["Puerto Ayacucho", "San Fernando de Atabapo", "Maroa", "La Esmeralda", "Isla Ratón"],
  "Anzoátegui": ["Barcelona", "Puerto La Cruz", "Lechería", "El Tigre", "Anaco", "Cantaura", "Guanta", "Aragua de Barcelona", "Onoto", "Pariaguán"],
  "Apure": ["San Fernando de Apure", "Guasdualito", "Biruaca", "Achaguas", "Elorza", "Bruzual", "Mantecal"],
  "Aragua": ["Maracay", "Turmero", "La Victoria", "Cagua", "El Limón", "Santa Rita", "Palo Negro", "San Mateo", "Villa de Cura", "Tejerías"],
  "Barinas": ["Barinas", "Barinitas", "Socopó", "Sabaneta", "Santa Bárbara", "Libertad", "Ciudad Bolivia", "Barrancas"],
  "Bolívar": ["Ciudad Bolívar", "Ciudad Guayana", "Puerto Ordaz", "San Félix", "Upata", "Caicara del Orinoco", "Tumeremo", "Santa Elena de Uairén", "El Callao", "Guasipati"],
  "Carabobo": ["Valencia", "Puerto Cabello", "Guacara", "San Diego", "Naguanagua", "Los Guayos", "Mariara", "Morón", "Bejuma", "Tocuyito"],
  "Cojedes": ["San Carlos", "Tinaquillo", "Tinaco", "El Baúl", "Las Vegas", "Libertad de Cojedes"],
  "Delta Amacuro": ["Tucupita", "Pedernales", "Curiapo", "Antonio Díaz"],
  "Distrito Capital": ["Caracas", "Catia", "El Valle", "La Pastora", "Coche", "Antímano", "Sucre (Caracas)", "Libertador"],
  "Falcón": ["Coro", "Punto Fijo", "Tucacas", "Chichiriviche", "Santa Ana de Coro", "Churuguara", "Pueblo Nuevo", "La Vela de Coro", "Mirimire", "Dabajuro"],
  "Guárico": ["San Juan de los Morros", "Calabozo", "Valle de la Pascua", "Zaraza", "Altagracia de Orituco", "Las Mercedes del Llano", "El Sombrero", "Tucupido"],
  "Lara": ["Barquisimeto", "Cabudare", "Quíbor", "El Tocuyo", "Carora", "Sanare", "Duaca", "Sarare", "Río Claro", "Tintorero"],
  "Mérida": ["Mérida", "Ejido", "El Vigía", "Tovar", "Bailadores", "Mucuchíes", "Timotes", "Santo Domingo (Mérida)", "Lagunillas (Mérida)"],
  "Miranda": ["Los Teques", "Guarenas", "Guatire", "Charallave", "Ocumare del Tuy", "Cúa", "San Antonio de los Altos", "Petare", "Higuerote", "Santa Teresa del Tuy", "Río Chico"],
  "Monagas": ["Maturín", "Caripito", "Punta de Mata", "Temblador", "Caripe", "Aragua de Maturín", "Quiriquire"],
  "Nueva Esparta": ["Porlamar", "La Asunción", "Pampatar", "Juan Griego", "San Juan Bautista", "El Valle del Espíritu Santo", "Boca de Río"],
  "Portuguesa": ["Guanare", "Acarigua", "Araure", "Turén", "Villa Bruzual", "Píritu (Portuguesa)", "Biscucuy", "Ospino", "Guanarito"],
  "Sucre": ["Cumaná", "Carúpano", "Güiria", "Cariaco", "Río Caribe", "Yaguaraparo", "San José de Aerocuar"],
  "Táchira": ["San Cristóbal", "Táriba", "Rubio", "La Fría", "Colón (Táchira)", "San Antonio del Táchira", "Ureña", "Santa Ana del Táchira", "La Grita", "Coloncito"],
  "Trujillo": ["Trujillo", "Valera", "Boconó", "Carache", "Betijoque", "Sabana de Mendoza", "Monay", "Escuque"],
  "La Guaira": ["La Guaira", "Catia La Mar", "Maiquetía", "Caraballeda", "Naiguatá", "Macuto", "Carayaca"],
  "Yaracuy": ["San Felipe", "Yaritagua", "Chivacoa", "Nirgua", "Cocorote", "Independencia (Yaracuy)", "Sabana de Parra"],
  "Zulia": ["Maracaibo", "Cabimas", "Ciudad Ojeda", "Santa Bárbara del Zulia", "Machiques", "Santa Rita (Zulia)", "La Concepción", "San Francisco (Zulia)", "Mene Grande", "Bachaquero", "Casigua El Cubo"]
};

export function ciudadesDeEstado(estado) {
  return CIUDADES_POR_ESTADO[estado] || [];
}

export function poblarSelectEstados(selectEl, placeholder) {
  const ph = placeholder || "Selecciona tu estado";
  selectEl.innerHTML = '<option value="">' + ph + '</option>' +
    ESTADOS_VENEZUELA.map((e) => '<option value="' + e + '">' + e + '</option>').join("");
}

export function poblarSelectCiudades(selectEl, estado, placeholder) {
  const ph = placeholder || "Selecciona tu ciudad";
  const ciudades = ciudadesDeEstado(estado);
  if (!estado || ciudades.length === 0) {
    selectEl.innerHTML = '<option value="">' + ph + '</option>';
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = false;
  selectEl.innerHTML = '<option value="">' + ph + '</option>' +
    ciudades.map((c) => '<option value="' + c + '">' + c + '</option>').join("");
}
