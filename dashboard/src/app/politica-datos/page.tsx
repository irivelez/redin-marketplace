import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Tratamiento de Datos — Redin",
  description:
    "Cómo Redin recoge, usa y protege tus datos personales. Ley 1581 de 2012 — Habeas Data, Colombia.",
};

const UPDATED_AT = "11 de junio de 2026";

export default function PoliticaDatosPage() {
  return (
    <article className="max-w-2xl mx-auto py-8">
      <h1 className="text-2xl font-bold text-slate-900">
        Política de Tratamiento de Datos Personales
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        Última actualización: {UPDATED_AT} — versión preliminar
      </p>

      <section className="mt-8 space-y-6 text-slate-700 leading-relaxed">
        <div>
          <h2 className="font-semibold text-slate-900">Quiénes somos</h2>
          <p>
            Redin — Red de Ingenieros Nacional (Cali, Colombia). Mantenemos
            sedes e instalaciones de empresas en todo el país y conectamos
            técnicos con trabajos de mantenimiento. Si tienes preguntas sobre
            tus datos, escríbenos por nuestro WhatsApp oficial — el mismo por
            donde te registraste.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">Qué datos recogemos</h2>
          <p>
            Cuando te registras por WhatsApp: tu nombre, ciudad, oficios y
            experiencia, número de celular, número y fotos de tu cédula, y los
            documentos que nos compartas (EPS, ARL, certificaciones). Si nos
            mandas notas de voz, también la transcripción de lo que dices.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">Para qué los usamos</h2>
          <p>
            Para confirmar que eres tú; armar tu perfil y aprobarte como
            técnico; ofrecerte trabajos que correspondan a tu oficio y tu
            ciudad; coordinar contratos y pagos; y avisarte del estado de tus
            postulaciones.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">
            Con quién los compartimos
          </h2>
          <p>
            Solo con el equipo de Redin y, cuando aceptas un trabajo, con el
            cliente de ese trabajo (lo mínimo necesario: tu nombre y contacto).
            No vendemos tus datos a nadie.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">
            Cuánto tiempo los guardamos
          </h2>
          <p>
            Mientras tengas perfil activo. Si pides borrarlos, los eliminamos,
            salvo lo que la ley nos obligue a conservar (por ejemplo, datos de
            contratos ya ejecutados).
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">
            Tus derechos (Ley 1581 de 2012)
          </h2>
          <p>
            Puedes conocer, actualizar, corregir y pedir que borremos tus
            datos, y revocar la autorización que nos diste. Es gratis y puedes
            hacerlo cuando quieras.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-slate-900">Cómo ejercerlos</h2>
          <p>
            Escríbele <strong>BORRAR</strong> o <strong>DATOS</strong> a Toño
            por WhatsApp — el equipo recibe tu solicitud de inmediato y te
            respondemos por ese mismo canal en máximo 15 días hábiles.
          </p>
        </div>
      </section>

      <p className="mt-10 text-sm text-slate-500 border-t border-slate-200 pt-4">
        Esta es una versión preliminar. El documento completo de política de
        tratamiento reemplazará esta página en esta misma URL.
      </p>
    </article>
  );
}
